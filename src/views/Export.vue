<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  createExportQualityReport,
  createProjectExport,
  getProjectFinalQualityRegression,
  getProjectCostLedger,
  getProjectExportPackage,
  getProjectProductionReadiness,
  getProjectReleaseCompliance,
  listFinalQualityReports,
  listProjectExports,
  reviewFinalQualityReport,
  saveExportFinalQualityRegressionTags,
  saveExportReleaseCompliance,
  type CostLedgerDTO,
  type ExportPackageDTO,
  type ExportPackageItemDTO,
  type FinalQualityReportDTO,
  type FinalQualityRegressionDTO,
  type ExportRecordDTO,
  type ProductionReadinessDTO,
  type ReleaseComplianceDTO,
} from '@/api/project'
import {
  getProjectMarketQualityAudit,
  type MarketQualityAuditDTO,
  type MarketQualityAuditItemDTO,
} from '@/api/market'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type PageState = 'missing-project' | 'loading' | 'empty' | 'ready' | 'exporting' | 'error'
type InfoTone = 'success' | 'warning'
type RegressionSampleFilter =
  | 'all'
  | 'missing-tags'
  | 'technical-blocked'
  | 'pending-review'
  | 'rework'
  | 'approved'
  | 'missing-review-decision'
  | 'missing-visual-evidence'
  | 'missing-subtitle-evidence'
  | 'missing-audio-evidence'
  | 'missing-character-evidence'

interface PlatformComplianceEvidence {
  aiLabelReviewed: boolean
  copyrightFieldsReviewed: boolean
  ruleReviewNote: string
}

interface RegressionCoverageOption {
  key: string
  label: string
}

interface AudioReviewEvidenceDraft {
  listeningConfirmed: boolean
  clarityReviewed: boolean
  loudnessReviewed: boolean
  clippingReviewed: boolean
  syncReviewed: boolean
  syncNotApplicable: boolean
}

const route = useRoute()
const router = useRouter()

const verticalTemplate = {
  format: 'H.264 / MP4',
  resolution: '1080 x 1920 (vertical)',
  frameRate: 24,
}
const burnSubtitle = ref(true)

const pageState = ref<PageState>('loading')
const exportPackage = ref<ExportPackageDTO | null>(null)
const exportHistory = ref<ExportRecordDTO[]>([])
const qualityReports = ref<FinalQualityReportDTO[]>([])
const qualityRegression = ref<FinalQualityRegressionDTO | null>(null)
const marketQualityAudit = ref<MarketQualityAuditDTO | null>(null)
const costLedger = ref<CostLedgerDTO | null>(null)
const releaseCompliance = ref<ReleaseComplianceDTO | null>(null)
const productionReadiness = ref<ProductionReadinessDTO | null>(null)
const historyErrorMsg = ref('')
const errorMsg = ref('')
const infoMsg = ref('')
const infoTone = ref<InfoTone>('success')
const reviewNote = ref('')
const reviewChecks = ref({
  visualReviewed: false,
  subtitleReviewed: false,
  audioReviewed: false,
  characterConsistencyReviewed: false,
  characterConsistencyNotApplicable: false,
})
const reviewEvidenceNotes = ref({
  visual: '',
  subtitle: '',
  audio: '',
  characterConsistency: '',
})
const reviewAudioEvidence = ref({
  listeningConfirmed: false,
  clarityReviewed: false,
  loudnessReviewed: false,
  clippingReviewed: false,
  syncReviewed: false,
  syncNotApplicable: false,
})
const reviewPlaybackCompleted = ref(false)
const reviewConfirmationToken = ref('')
const isSavingReview = ref(false)
const isSavingCompliance = ref(false)
const complianceLabel = ref('本内容包含 AI 生成内容')
const complianceConfirmed = ref(false)
const complianceConfirmationToken = ref('')
const platformComplianceEvidence = ref<Record<string, PlatformComplianceEvidence>>({})
const regressionCoverageOptions: RegressionCoverageOption[] = [
  { key: 'empty-scene', label: '空镜头' },
  { key: 'single-character', label: '单人镜头' },
  { key: 'two-character', label: '双人镜头' },
  { key: 'dialogue', label: '对白镜头' },
  { key: 'narration', label: '旁白镜头' },
  { key: 'action', label: '动作镜头' },
]
const regressionCoverageLabelByKey = Object.fromEntries(
  regressionCoverageOptions.map((option) => [option.key, option.label]),
) as Record<string, string>
const regressionEvidenceGapFilterByKey: Partial<Record<RegressionSampleFilter, string>> = {
  'missing-review-decision': 'human-review-decision-missing',
  'missing-visual-evidence': 'visual-evidence-missing',
  'missing-subtitle-evidence': 'subtitle-evidence-missing',
  'missing-audio-evidence': 'audio-evidence-missing',
  'missing-character-evidence': 'character-consistency-evidence-missing',
}
const regressionEvidenceGapFilterKeyByCode = Object.fromEntries(
  Object.entries(regressionEvidenceGapFilterByKey).map(([filterKey, code]) => [code, filterKey]),
) as Record<string, RegressionSampleFilter>
const regressionTagDraft = ref<string[]>([])
const regressionTagNote = ref('')
const regressionTagConfirmationToken = ref('')
const regressionTagTargetExportId = ref<number | null>(null)
const regressionReviewTargetExportId = ref<number | null>(null)
const regressionReviewChecks = ref({
  visualReviewed: false,
  subtitleReviewed: false,
  audioReviewed: false,
  characterConsistencyReviewed: false,
  characterConsistencyNotApplicable: false,
})
const regressionReviewEvidenceNotes = ref({
  visual: '',
  subtitle: '',
  audio: '',
  characterConsistency: '',
})
const regressionReviewAudioEvidence = ref({
  listeningConfirmed: false,
  clarityReviewed: false,
  loudnessReviewed: false,
  clippingReviewed: false,
  syncReviewed: false,
  syncNotApplicable: false,
})
const regressionReviewPlaybackCompleted = ref(false)
const regressionReviewNote = ref('')
const regressionReviewConfirmationToken = ref('')
const regressionSampleFilter = ref<RegressionSampleFilter>('all')
const isSavingRegressionTags = ref(false)
const isSavingRegressionSampleReview = ref(false)
const isCreatingRegressionSampleReport = ref(false)
const regressionReviewSummaryMessage = ref('')
let syncedRegressionTagExportId: number | null = null
let syncedRegressionReviewExportId: number | null = null
let syncedLatestQualityReportId: number | null = null
let exportPollTimer: number | null = null

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})
const episodeNo = computed(() => {
  const value = Number(route.query.episodeNo) || 0
  return value > 0 ? value : undefined
})

const latestExport = computed<ExportRecordDTO | null>(() => exportHistory.value[0] || null)
const visibleExportHistory = computed(() => exportHistory.value.slice(0, 6))
const olderExportHistory = computed(() => exportHistory.value.slice(6))
const latestQualityReport = computed<FinalQualityReportDTO | null>(() => {
  if (!latestExport.value) return null
  return qualityReports.value.find((item) => item.exportId === latestExport.value?.id) || null
})

function setInfo(message: string, tone: InfoTone = 'success'): void {
  infoMsg.value = message
  infoTone.value = tone
}

const latestMarketQualityItem = computed<MarketQualityAuditItemDTO | null>(() => {
  const items = marketQualityAudit.value?.items || []
  return (
    items.find((item) => item.exportId === latestExport.value?.id) ||
    items.find((item) => item.storageReadable) ||
    null
  )
})

const machineAuditRows = computed(() => {
  const mediaCodes = new Set([
    'invalid-vertical-spec',
    'black-bars-detected',
    'freeze-frame-risk',
    'dropped-frame-risk',
  ])
  const subtitleCodes = new Set([
    'subtitle-cue-count-mismatch',
    'subtitle-text-mismatch',
    'subtitle-timeline-drift',
    'subtitle-out-of-range',
    'subtitle-overlap',
    'subtitle-unsafe-area',
    'subtitle-missing',
  ])
  const audioCodes = new Set([
    'audio-sample-rate',
    'audio-not-measurable',
    'audio-too-quiet',
    'audio-true-peak-risk',
    'audio-clipping',
    'speech-sync-evidence-missing',
    'speech-sync-out-of-tolerance',
  ])
  const characterCodes = new Set([
    'character-baseline-incomplete',
    'character-baseline-missing',
    'character-version-mismatch',
    'character-version-evidence-missing',
  ])
  const releaseCodes = new Set(['platform-evidence-incomplete'])

  const hasCode = (codes: Set<string>, blockers: Array<{ code?: string }>) =>
    blockers.some((blocker) => codes.has(String(blocker.code || '')))
  const dimensionPassed = (item: MarketQualityAuditItemDTO, key: string) =>
    item.audit?.dimensions?.[key]?.passed === true
  const statusFor = (passed: boolean) => (passed ? '通过' : '阻塞')

  return (marketQualityAudit.value?.items || []).map((item) => {
    const blockers = [
      ...(item.audit?.technicalBlockers || []),
      ...(item.audit?.hardBlockers || []),
      ...(item.blockers || []),
    ].filter((blocker, index, list) => {
      const code = String(blocker.code || '')
      return code && list.findIndex((candidate) => candidate.code === code) === index
    })
    const mediaPassed = dimensionPassed(item, 'media') && !hasCode(mediaCodes, blockers)
    const subtitlePassed = dimensionPassed(item, 'subtitle') && !hasCode(subtitleCodes, blockers)
    const audioPassed = dimensionPassed(item, 'audio') && !hasCode(audioCodes, blockers)
    const characterPassed = dimensionPassed(item, 'characters') && !hasCode(characterCodes, blockers)
    const releasePassed = dimensionPassed(item, 'platform') && !hasCode(releaseCodes, blockers)
    return {
      ...item,
      technicalPassed: item.technicalProxyPassed === true,
      blockers,
      checks: [
        { key: 'media', label: '画面规格', passed: mediaPassed },
        { key: 'subtitle', label: '字幕时间轴', passed: subtitlePassed },
        { key: 'audio', label: '音频检测', passed: audioPassed },
        { key: 'character', label: '角色证据', passed: characterPassed },
        { key: 'release', label: '发布材料', passed: releasePassed },
      ],
      blockerText: blockers.slice(0, 4).map((blocker) => blocker.message).join('；'),
      statusText: statusFor(item.technicalProxyPassed === true),
    }
  })
})

function marketDimension(item: MarketQualityAuditItemDTO | null, key: string) {
  return item?.audit?.dimensions?.[key] || null
}

function marketDimensionPassed(item: MarketQualityAuditItemDTO | null, key: string) {
  return marketDimension(item, key)?.passed === true
}

function marketDimensionStatus(item: MarketQualityAuditItemDTO | null, key: string) {
  const dimension = marketDimension(item, key)
  if (!dimension) return '缺少证据'
  return dimension.passed === true ? '通过' : '阻塞'
}

function marketObserved(item: MarketQualityAuditItemDTO | null, key: string, field: string) {
  const value = marketDimension(item, key)?.observed?.[field]
  return value === undefined || value === null || value === '' ? '-' : String(value)
}

function marketRecordValue(
  record: Record<string, unknown> | null | undefined,
  field: string,
) {
  const value = record?.[field]
  return value === undefined || value === null || value === '' ? '-' : String(value)
}

function getPlaybackUrl(record: ExportRecordDTO) {
  return record.playbackUrl || record.videoUrl
}
const canApproveLatestQuality = computed(() =>
  latestQualityReport.value?.automaticPassed === true &&
  reviewChecks.value.visualReviewed &&
  reviewChecks.value.subtitleReviewed &&
  reviewChecks.value.audioReviewed &&
  reviewAudioEvidence.value.listeningConfirmed &&
  reviewAudioEvidence.value.clarityReviewed &&
  reviewAudioEvidence.value.loudnessReviewed &&
  reviewAudioEvidence.value.clippingReviewed &&
  (reviewAudioEvidence.value.syncReviewed || reviewAudioEvidence.value.syncNotApplicable) &&
  (reviewChecks.value.characterConsistencyReviewed ||
    reviewChecks.value.characterConsistencyNotApplicable) &&
  reviewEvidenceNotes.value.visual.trim() &&
  reviewEvidenceNotes.value.subtitle.trim() &&
  reviewEvidenceNotes.value.audio.trim() &&
  reviewEvidenceNotes.value.characterConsistency.trim() &&
  reviewConfirmationToken.value.trim() === 'APPROVE_FINAL_QUALITY_REVIEW',
)
const complianceTotalText = computed(() => {
  const totals = costLedger.value?.summary.totalEstimatedCostByCurrency || {}
  const entries = Object.entries(totals)
  if (!entries.length) return '暂无已配置价格'
  return entries.map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join(' / ')
})
const costLedgerHasPricing = computed(() => {
  const ledger = costLedger.value
  return Boolean(
    ledger?.pricingCatalogConfigured &&
      Object.keys(ledger.summary.totalEstimatedCostByCurrency || {}).length,
  )
})
const regressionAverageCostText = computed(() => {
  const totals = qualityRegression.value?.cost.averageEstimatedCostByCurrency || {}
  const entries = Object.entries(totals)
  if (!entries.length) return '暂无已计价样本'
  return entries.map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join(' / ')
})
const regressionApprovalRateText = computed(() => {
  const rate = qualityRegression.value?.summary.approvalRate ?? 0
  return `${Math.round(rate * 100)}%`
})
const regressionMissingCoverageText = computed(() => {
  const missing = qualityRegression.value?.coverage.missingBuckets || []
  if (!missing.length) return '覆盖完整'
  return missing.map((item) => item.label).join(' / ')
})
const productionReadinessStatusText = computed(() => {
  const status = productionReadiness.value?.status || 'unknown'
  const labels: Record<string, string> = {
    blocked: '仍有阻塞',
    'ready-for-controlled-publish': '可进入受控试发布',
    'stable-revenue-evidence-ready': '已有收入验证证据',
  }
  return labels[status] || status
})
const productionReadinessStageRows = computed(() => {
  const stages = productionReadiness.value?.stages
  if (!stages) return []
  return [
    {
      key: 'finalEditRegression',
      label: '10 条终剪回归',
      status: stages.finalEditRegression.status,
      passed: stages.finalEditRegression.passed,
      blockerCount: stages.finalEditRegression.blockers.length,
    },
    {
      key: 'marketMachineQuality',
      label: '机器质检',
      status: stages.marketMachineQuality.status,
      passed: stages.marketMachineQuality.passed,
      blockerCount: stages.marketMachineQuality.blockers.length,
    },
    {
      key: 'releaseCompliance',
      label: '发布合规',
      status: stages.releaseCompliance.status,
      passed: stages.releaseCompliance.passed,
      blockerCount: stages.releaseCompliance.blockers.length,
    },
    {
      key: 'storageOperations',
      label: '存储运维',
      status: stages.storageOperations.status,
      passed: stages.storageOperations.passed,
      blockerCount: stages.storageOperations.blockers.length,
    },
    {
      key: 'costControl',
      label: '成本计价',
      status: stages.costControl.status,
      passed: stages.costControl.passed,
      blockerCount: stages.costControl.blockers.length,
    },
    {
      key: 'platformValidation',
      label: '平台与收入',
      status: stages.platformValidation.status,
      passed: stages.platformValidation.passed,
      blockerCount: stages.platformValidation.blockers.length,
    },
  ]
})
const regressionTagTargets = computed(() => {
  const sampleIds = new Set(
    (qualityRegression.value?.items || [])
      .map((item) => Number(item.exportId) || 0)
      .filter((exportId) => exportId > 0),
  )
  if (latestExport.value?.id) {
    sampleIds.add(latestExport.value.id)
  }
  return [...sampleIds].map((exportId) => {
    const sample = qualityRegression.value?.items.find((item) => item.exportId === exportId)
    const record = exportHistory.value.find((item) => item.id === exportId)
    return {
      exportId,
      status: sample?.status || record?.status || 'unknown',
      coverageTags: sample?.coverageTags || [],
    }
  })
})
const regressionReviewTargetExport = computed<ExportRecordDTO | null>(() =>
  findRegressionExportRecord(regressionReviewTargetExportId.value),
)
const regressionReviewTargetSample = computed(() => {
  const exportId = regressionReviewTargetExportId.value
  if (!exportId) return null
  return regressionSampleRows.value.find((item) => item.exportId === exportId) || null
})
const regressionReviewTargetReport = computed<FinalQualityReportDTO | null>(() => {
  const exportId = regressionReviewTargetExportId.value
  if (!exportId) return null
  return qualityReports.value.find((item) => item.exportId === exportId) || null
})
const regressionReviewTargetTodoItems = computed(() => {
  const sample = regressionReviewTargetSample.value
  const report = regressionReviewTargetReport.value
  if (!sample && !report) return []

  const todos: Array<{ key: string; label: string; detail: string }> = []
  const evidenceGaps = sample?.reviewEvidenceGaps || []
  const hasEvidenceGap = (code: string) => evidenceGaps.some((gap) => gap.code === code)

  if (!report) {
    todos.push({
      key: 'missing-quality-report',
      label: '缺少技术质量报告',
      detail: '先为这一条已完成导出生成技术质量报告，再进入人工复核。',
    })
  } else if (!report.automaticPassed || sample?.technicalPassed === false) {
    todos.push({
      key: 'technical-quality-blocked',
      label: '技术质检阻塞',
      detail: sample?.gapText || '自动技术质检未通过，需要先排查规格、声音、黑边或对象可读性。',
    })
  }

  if (hasEvidenceGap('visual-evidence-missing')) {
    todos.push({
      key: 'visual-evidence-missing',
      label: '画面证据',
      detail: '需要记录拉伸、黑边、跳帧、主体裁切和画面观感结论。',
    })
  }
  if (hasEvidenceGap('subtitle-evidence-missing')) {
    todos.push({
      key: 'subtitle-evidence-missing',
      label: '字幕证据',
      detail: '需要记录字幕准确性、错别字和安全区结论。',
    })
  }
  if (hasEvidenceGap('audio-evidence-missing')) {
    todos.push({
      key: 'audio-evidence-missing',
      label: '音频证据',
      detail: '需要记录对白清晰度、响度、爆音、BGM/SFX 和对嘴结论。',
    })
  }
  if (hasEvidenceGap('character-consistency-evidence-missing')) {
    todos.push({
      key: 'character-consistency-evidence-missing',
      label: '人物一致性证据',
      detail: '需要记录人物外貌、发型、服装、体型和同屏角色数量结论。',
    })
  }
  if (sample?.reviewDecision !== 'approved') {
    todos.push({
      key: 'human-approval-missing',
      label: '人工批准',
      detail: '只有四项人工证据补齐并输入批准口令后，才允许保存人工通过。',
    })
  }

  return todos
})
const regressionReviewEvidenceSummaryItems = computed(() => {
  const report = regressionReviewTargetReport.value
  if (!report) return []

  const evidenceDefinitions = [
    { key: 'visual' as const, label: '画面证据' },
    { key: 'subtitle' as const, label: '字幕证据' },
    { key: 'audio' as const, label: '音频证据' },
    { key: 'characterConsistency' as const, label: '人物一致性证据' },
  ]

  return evidenceDefinitions.map((item) => {
    const evidence = resolveReviewEvidence(report, item.key)
    const saved = (evidence.reviewed || evidence.notApplicable) && Boolean(evidence.note)
    return {
      ...item,
      saved,
      status: saved ? '已留存' : '未留存',
      note: evidence.note || '尚无已保存的终审备注。',
    }
  })
})
const regressionReviewDraftStatusItems = computed(() => {
  const report = regressionReviewTargetReport.value
  if (!report) return []

  const evidenceDefinitions = [
    {
      key: 'visual' as const,
      label: '画面证据',
      draftReviewed: regressionReviewChecks.value.visualReviewed,
      draftNotApplicable: false,
      draftNote: regressionReviewEvidenceNotes.value.visual,
    },
    {
      key: 'subtitle' as const,
      label: '字幕证据',
      draftReviewed: regressionReviewChecks.value.subtitleReviewed,
      draftNotApplicable: false,
      draftNote: regressionReviewEvidenceNotes.value.subtitle,
    },
    {
      key: 'audio' as const,
      label: '音频证据',
      draftReviewed: regressionReviewChecks.value.audioReviewed,
      draftNotApplicable: false,
      draftNote: regressionReviewEvidenceNotes.value.audio,
    },
    {
      key: 'characterConsistency' as const,
      label: '人物一致性证据',
      draftReviewed: regressionReviewChecks.value.characterConsistencyReviewed,
      draftNotApplicable: regressionReviewChecks.value.characterConsistencyNotApplicable,
      draftNote: regressionReviewEvidenceNotes.value.characterConsistency,
    },
  ]

  const evidenceItems = evidenceDefinitions.map((item) => {
    const saved = resolveReviewEvidence(report, item.key)
    const savedAudio = item.key === 'audio' ? resolveAudioReviewEvidence(report) : null
    const audioChanged =
      item.key === 'audio' &&
      Boolean(savedAudio) &&
      JSON.stringify(savedAudio) !== JSON.stringify(regressionReviewAudioEvidence.value)
    const changed =
      saved.reviewed !== item.draftReviewed ||
      saved.notApplicable !== item.draftNotApplicable ||
      normalizeReviewText(saved.note) !== normalizeReviewText(item.draftNote) ||
      audioChanged
    return {
      key: item.key,
      label: item.label,
      changed,
      status: changed ? '尚未保存的改动' : '与报告一致',
      detail: changed
        ? '当前输入尚未保存；点击保存后才会写入质量报告。'
        : '当前输入与已保存报告快照一致。',
    }
  })

  const reviewNoteChanged =
    normalizeReviewText(report.reviewNote || '') !== normalizeReviewText(regressionReviewNote.value)

  return [
    ...evidenceItems,
    {
      key: 'review-note',
      label: '复核结论备注',
      changed: reviewNoteChanged,
      status: reviewNoteChanged ? '尚未保存的改动' : '与报告一致',
      detail: reviewNoteChanged
        ? '当前复核结论备注尚未保存；保存前不会进入审计记录。'
        : '当前复核结论备注与已保存报告一致。',
    },
  ]
})
const hasRegressionReviewUnsavedDraft = computed(() =>
  regressionReviewDraftStatusItems.value.some((item) => item.changed),
)
const regressionReviewApprovalBlockers = computed(() => {
  const report = regressionReviewTargetReport.value
  const sample = regressionReviewTargetSample.value
  if (!regressionReviewTargetExportId.value) return []

  const blockers: Array<{ key: string; label: string; detail: string }> = []
  if (!report) {
    blockers.push({
      key: 'missing-quality-report',
      label: '缺少技术质量报告',
      detail: '先生成这一条已完成导出的技术质量报告，才能判断是否可以人工批准。',
    })
    return blockers
  }
  if (!report.automaticPassed || sample?.technicalPassed === false) {
    blockers.push({
      key: 'technical-quality-blocked',
      label: '技术质检阻塞',
      detail: sample?.gapText || '自动技术质检未通过，不能进入人工批准。',
    })
    return blockers
  }

  const evidenceDefinitions = [
    {
      key: 'visual',
      label: '画面证据',
      reviewed: regressionReviewChecks.value.visualReviewed,
      note: regressionReviewEvidenceNotes.value.visual,
    },
    {
      key: 'subtitle',
      label: '字幕证据',
      reviewed: regressionReviewChecks.value.subtitleReviewed,
      note: regressionReviewEvidenceNotes.value.subtitle,
    },
    {
      key: 'audio',
      label: '音频证据',
      reviewed: regressionReviewChecks.value.audioReviewed,
      note: regressionReviewEvidenceNotes.value.audio,
    },
    {
      key: 'character-consistency',
      label: '人物一致性证据',
      reviewed: regressionReviewChecks.value.characterConsistencyReviewed,
      notApplicable: regressionReviewChecks.value.characterConsistencyNotApplicable,
      note: regressionReviewEvidenceNotes.value.characterConsistency,
    },
  ]

  for (const evidence of evidenceDefinitions) {
    if (!evidence.reviewed && !evidence.notApplicable) {
      blockers.push({
        key: `${evidence.key}-review-missing`,
        label: evidence.label,
        detail: '尚未勾选已复核。',
      })
    } else if (!evidence.note.trim()) {
      blockers.push({
        key: `${evidence.key}-note-missing`,
        label: evidence.label,
        detail: '已勾选复核，但尚未填写终审备注。',
      })
    }
  }
  const audioListeningReady =
    regressionReviewAudioEvidence.value.listeningConfirmed &&
    regressionReviewAudioEvidence.value.clarityReviewed &&
    regressionReviewAudioEvidence.value.loudnessReviewed &&
    regressionReviewAudioEvidence.value.clippingReviewed &&
    (regressionReviewAudioEvidence.value.syncReviewed ||
      regressionReviewAudioEvidence.value.syncNotApplicable)
  if (!audioListeningReady) {
    blockers.push({
      key: 'audio-listening-evidence-incomplete',
      label: '音频人工复核仍缺少实际听感字段',
      detail: '必须实际完整播放，并分别确认清晰度、响度、失真和对白同步；无可见说话人物才可选择同步不适用。',
    })
  }
  if (regressionReviewConfirmationToken.value.trim() !== 'APPROVE_FINAL_QUALITY_REVIEW') {
    blockers.push({
      key: 'approval-token-missing',
      label: '缺少批准确认口令',
      detail: '输入精确口令后，批准按钮才会启用。',
    })
  }

  return blockers
})
const regressionReviewSummaryText = computed(() => {
  const exportId = regressionReviewTargetExportId.value
  const sample = regressionReviewTargetSample.value
  const report = regressionReviewTargetReport.value
  if (!exportId) return ''

  const decisionText = report
    ? report.reviewDecision === 'approved'
      ? '人工通过'
      : report.reviewDecision === 'rework'
        ? '人工返工'
        : '尚未复核'
    : '尚未复核'
  const evidenceText = regressionReviewDraftStatusItems.value.length
    ? regressionReviewDraftStatusItems.value
        .map((item) => `- ${item.label}：${item.status}`)
        .join('\n')
    : '- 暂无质量报告或终审证据'
  const blockerText = regressionReviewApprovalBlockers.value.length
    ? regressionReviewApprovalBlockers.value.map((item) => `- ${item.label}：${item.detail}`).join('\n')
    : '- 当前表单没有审批前缺口'

  return [
    '帧心帧意 人工终审摘要',
    `项目：#${projectId.value || '-'}`,
    `导出：#${exportId}`,
    `技术状态：${sample?.technicalText || '暂无样本状态'}`,
    `质量报告：${report ? `#${report.id}` : '未生成'}`,
    `人工结论：${decisionText}`,
    `内部发布状态：${report?.releaseStatus || 'blocked'}`,
    `覆盖类型：${sample?.coverageText || '未标记'}`,
    `当前输入：${hasRegressionReviewUnsavedDraft.value ? '存在未保存改动' : '与质量报告一致'}`,
    '',
    '证据保存状态：',
    evidenceText,
    '',
    '审批前缺口：',
    blockerText,
    '',
    '边界说明：只读摘要，不保存、不发布、不启动 Worker 或模型；内部发布状态不代表平台审核通过或稳定盈利。',
  ].join('\n')
})
const regressionReviewSaveScopeItems = computed(() => {
  const exportId = regressionReviewTargetExportId.value
  const report = regressionReviewTargetReport.value
  if (!exportId) return []

  return [
    {
      key: 'current-quality-report',
      label: '只更新当前质量报告',
      detail: report
        ? `保存目标为 Export #${exportId} 的质量报告 #${report.id}。`
        : `Export #${exportId} 还没有质量报告，不能保存人工复核。`,
    },
    {
      key: 'no-platform-publish',
      label: '不会发布到平台',
      detail: '批准只会进入内部发布候选证据链，仍需平台合规确认和人工上传/发布。',
    },
    {
      key: 'no-new-export',
      label: '不会创建新导出',
      detail: '返工或批准不会重剪视频、不会新增导出记录，也不会删除已有媒体。',
    },
    {
      key: 'no-worker-model',
      label: '不会启动 Worker 或模型',
      detail: '该区域只保存人工复核结论和证据，不会消费队列或产生模型费用。',
    },
  ]
})
const regressionReviewAuditItems = computed(() => {
  const report = regressionReviewTargetReport.value
  if (!report) return []

  const decisionText =
    report.reviewDecision === 'approved'
      ? '人工通过'
      : report.reviewDecision === 'rework'
        ? '人工返工'
        : '尚未复核'
  const reviewedByText = report.reviewedBy ? `用户 #${report.reviewedBy}` : '暂无记录'

  return [
    {
      key: 'review-decision',
      label: '人工结论',
      value: decisionText,
      detail: report.reviewNote || '暂无复核备注。',
    },
    {
      key: 'reviewed-at',
      label: '复核时间',
      value: formatAuditTime(report.reviewedAt),
      detail: `复核人：${reviewedByText}`,
    },
    {
      key: 'updated-at',
      label: '最后更新',
      value: formatAuditTime(report.updatedAt),
      detail: `质量报告 #${report.id}`,
    },
    {
      key: 'release-status',
      label: '发布状态',
      value: report.releaseStatus || 'blocked',
      detail: '该状态只代表内部发布候选证据链，不代表平台审核通过。',
    },
  ]
})
const canApproveRegressionSampleReview = computed(() =>
  regressionReviewTargetReport.value?.automaticPassed === true &&
  regressionReviewChecks.value.visualReviewed &&
  regressionReviewChecks.value.subtitleReviewed &&
  regressionReviewChecks.value.audioReviewed &&
  regressionReviewAudioEvidence.value.listeningConfirmed &&
  regressionReviewAudioEvidence.value.clarityReviewed &&
  regressionReviewAudioEvidence.value.loudnessReviewed &&
  regressionReviewAudioEvidence.value.clippingReviewed &&
  (regressionReviewAudioEvidence.value.syncReviewed ||
    regressionReviewAudioEvidence.value.syncNotApplicable) &&
  (regressionReviewChecks.value.characterConsistencyReviewed ||
    regressionReviewChecks.value.characterConsistencyNotApplicable) &&
  regressionReviewEvidenceNotes.value.visual.trim() &&
  regressionReviewEvidenceNotes.value.subtitle.trim() &&
  regressionReviewEvidenceNotes.value.audio.trim() &&
  regressionReviewEvidenceNotes.value.characterConsistency.trim() &&
  regressionReviewConfirmationToken.value.trim() === 'APPROVE_FINAL_QUALITY_REVIEW',
)
const canCreateRegressionSampleReport = computed(
  () =>
    regressionReviewTargetExport.value?.status === 'completed' &&
    !regressionReviewTargetReport.value &&
    !isCreatingRegressionSampleReport.value,
)
const regressionSampleRows = computed(() =>
  (qualityRegression.value?.items || []).map((item) => ({
    ...item,
    hasQualityReport: qualityReports.value.some((report) => report.exportId === item.exportId),
    technicalText: item.technicalPassed ? '技术通过' : '技术阻塞',
    reviewText:
      item.reviewDecision === 'approved'
        ? '人工通过'
        : item.reviewDecision === 'rework'
          ? '人工返工'
          : '待人工复核',
    releaseText: item.releaseStatus || '未进发布候选',
    coverageText: formatRegressionCoverageTags(item.coverageTags),
    gapText: formatRegressionQualityGaps(item.qualityGapCodes),
    reviewEvidenceGaps: item.reviewEvidenceGaps || [],
    reviewEvidenceGapText: formatRegressionReviewEvidenceGaps(item.reviewEvidenceGaps || []),
    nextActionText: item.nextAction?.label || '待补处理建议',
    nextActionMessage: item.nextAction?.message || '当前样本缺少下一步处理建议。',
  })),
)
const regressionReviewQueueSummary = computed(() => {
  const rows = regressionSampleRows.value
  return {
    missingReports: rows.filter((item) => !item.hasQualityReport).length,
    technicalBlocked: rows.filter((item) => item.hasQualityReport && !item.technicalPassed).length,
    evidenceGaps: rows.filter((item) => item.reviewEvidenceGaps.length > 0).length,
    ready: rows.filter(
      (item) =>
        item.hasQualityReport &&
        item.technicalPassed &&
        item.reviewEvidenceGaps.length === 0 &&
        item.reviewDecision === 'approved',
    ).length,
  }
})
const regressionGapSummary = computed(() => {
  const rows = qualityRegression.value?.items || []
  return {
    missingTags: rows.filter((item) => item.coverageTags.length === 0).length,
    technicalBlocked: rows.filter((item) => !item.technicalPassed).length,
    pendingHumanReview: rows.filter((item) => !item.reviewDecision).length,
    rework: rows.filter((item) => item.reviewDecision === 'rework').length,
    approved: rows.filter((item) => item.reviewDecision === 'approved').length,
  }
})
const regressionEvidenceGapBuckets = computed(() => qualityRegression.value?.reviewEvidence.buckets || [])
const regressionSampleFilterOptions = computed(() => [
  { key: 'all' as const, label: '全部', count: regressionSampleRows.value.length },
  { key: 'missing-tags' as const, label: '未标记', count: regressionGapSummary.value.missingTags },
  {
    key: 'technical-blocked' as const,
    label: '技术阻塞',
    count: regressionGapSummary.value.technicalBlocked,
  },
  {
    key: 'pending-review' as const,
    label: '待复核',
    count: regressionGapSummary.value.pendingHumanReview,
  },
  { key: 'rework' as const, label: '返工', count: regressionGapSummary.value.rework },
  { key: 'approved' as const, label: '已通过', count: regressionGapSummary.value.approved },
])
const filteredRegressionSampleRows = computed(() => {
  const rows = regressionSampleRows.value
  const evidenceGapCode = regressionEvidenceGapFilterByKey[regressionSampleFilter.value]
  if (evidenceGapCode) {
    return rows.filter((item) =>
      item.reviewEvidenceGaps.some((gap) => gap.code === evidenceGapCode),
    )
  }
  switch (regressionSampleFilter.value) {
    case 'missing-tags':
      return rows.filter((item) => item.coverageTags.length === 0)
    case 'technical-blocked':
      return rows.filter((item) => !item.technicalPassed)
    case 'pending-review':
      return rows.filter((item) => !item.reviewDecision)
    case 'rework':
      return rows.filter((item) => item.reviewDecision === 'rework')
    case 'approved':
      return rows.filter((item) => item.reviewDecision === 'approved')
    default:
      return rows
  }
})
const readyItems = computed(() =>
  exportPackage.value?.items.filter((item) => item.exportStatus === 'ready') || [],
)
const missingItems = computed(() =>
  exportPackage.value?.items.filter((item) => item.exportStatus !== 'ready') || [],
)
const canExport = computed(() => exportPackage.value?.canExport === true)
const canSaveCompliance = computed(
  () => complianceConfirmationToken.value.trim() === 'CONFIRM_RELEASE_COMPLIANCE_REVIEW',
)
const canSaveRegressionTags = computed(
  () =>
    Boolean(regressionTagTargetExportId.value) &&
    regressionTagDraft.value.length > 0 &&
    regressionTagConfirmationToken.value.trim() === 'CONFIRM_FINAL_QUALITY_REGRESSION_TAGS',
)
const canSaveRegressionSampleRework = computed(
  () => Boolean(regressionReviewTargetReport.value) && !isSavingRegressionSampleReview.value,
)
const exportButtonText = computed(() => {
  if (pageState.value === 'exporting') return '导出生成中...'
  return '开始生成导出包'
})
const exportHint = computed(() => {
  if (pageState.value === 'exporting') return '正在写入 mock 导出记录，请稍候'
  if ((exportPackage.value?.missingStoryboardScenes || 0) > 0) {
    return `还有 ${exportPackage.value?.missingStoryboardScenes || 0} 个场景未生成分镜`
  }
  if ((exportPackage.value?.missingShots || 0) > 0) {
    return `还有 ${exportPackage.value?.missingShots || 0} 个分镜未确认最终视频`
  }
  return `已就绪 ${exportPackage.value?.readyShots || 0} / ${exportPackage.value?.totalShots || 0} 个分镜`
})

function formatDuration(seconds?: number | null): string {
  const total = Number(seconds) || 0
  if (total <= 0) return '0s'
  const mins = Math.floor(total / 60)
  const rest = total % 60
  if (mins <= 0) return `${rest}s`
  if (rest === 0) return `${mins}m`
  return `${mins}m ${rest}s`
}

function formatAuditTime(value?: string | null): string {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function normalizeReviewText(value?: string | null): string {
  return String(value || '').trim()
}

async function copyRegressionReviewSummary(): Promise<void> {
  const text = regressionReviewSummaryText.value.trim()
  if (!text) return

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', 'true')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      if (!copied) throw new Error('clipboard-copy-failed')
    }
    regressionReviewSummaryMessage.value = '终审摘要已复制到剪贴板。'
  } catch {
    regressionReviewSummaryMessage.value = '复制失败，请使用下载终审摘要保存文本。'
  }
}

function downloadRegressionReviewSummary(): void {
  const text = regressionReviewSummaryText.value.trim()
  const exportId = regressionReviewTargetExportId.value
  if (!text || !exportId) return

  const blob = new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `projectdream-export-${exportId}-final-review.txt`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  regressionReviewSummaryMessage.value = '终审摘要已下载为文本文件。'
}

function printRegressionReviewChecklist(): void {
  if (!regressionReviewTargetExportId.value) return
  window.print()
}

function resolveShotLabel(item: ExportPackageItemDTO): string {
  return item.shotNo || `SHOT ${item.storyboardId}`
}

function goDashboard(): void {
  router.push('/dashboard')
}

function goFinalEdit(): void {
  if (!projectId.value) {
    router.push('/dashboard')
    return
  }
  router.push({
    path: '/workspace/edit',
    query: { projectId: String(projectId.value) },
  })
}

function goWorkspace(): void {
  if (!projectId.value) {
    router.push('/dashboard')
    return
  }
  router.push({
    path: '/workspace/scenes',
    query: { projectId: String(projectId.value) },
  })
}

function syncReleaseComplianceForm(compliance: ReleaseComplianceDTO | null): void {
  releaseCompliance.value = compliance
  complianceConfirmed.value = compliance?.aiDisclosure.disclosureConfirmed === true
  complianceLabel.value = compliance?.aiDisclosure.label || '本内容包含 AI 生成内容'

  const savedEvidence = [
    ...(compliance?.aiDisclosure.platformEvidence || []),
    ...(compliance?.checks.platformCompliance?.evidence || []),
  ]
  const nextEvidence: Record<string, PlatformComplianceEvidence> = {}
  for (const platform of compliance?.platforms || []) {
    const current = platformComplianceEvidence.value[platform]
    const saved = savedEvidence.find((item) => item.platform === platform)
    nextEvidence[platform] = {
      aiLabelReviewed: current?.aiLabelReviewed ?? saved?.aiLabelReviewed === true,
      copyrightFieldsReviewed:
        current?.copyrightFieldsReviewed ?? saved?.copyrightFieldsReviewed === true,
      ruleReviewNote: current?.ruleReviewNote ?? saved?.ruleReviewNote ?? '',
    }
  }
  platformComplianceEvidence.value = nextEvidence
}

function resolvePlatformEvidencePayload() {
  return (releaseCompliance.value?.platforms || []).map((platform) => {
    const evidence = platformComplianceEvidence.value[platform]
    return {
      platform,
      aiLabelReviewed: evidence?.aiLabelReviewed === true,
      copyrightFieldsReviewed: evidence?.copyrightFieldsReviewed === true,
      ruleReviewNote: evidence?.ruleReviewNote?.trim() || null,
    }
  })
}

function platformLabel(platform: string): string {
  const labels: Record<string, string> = {
    hongguo: '红果',
    douyin: '抖音',
  }
  return labels[platform] || platform
}

function formatRegressionCoverageTags(tags: string[]): string {
  if (!tags.length) return '未标记'
  return tags.map((tag) => regressionCoverageLabelByKey[tag] || tag).join(' / ')
}

function formatRegressionQualityGaps(codes: string[]): string {
  if (!codes.length) return '暂无阻塞'
  const labels: Record<string, string> = {
    'automatic-quality-blocked': '自动技术质检未通过',
    'human-review-missing': '缺人工复核',
    'human-rework': '人工要求返工',
    'human-review-evidence-incomplete': '人工证据不完整',
    'character-consistency-unreviewed': '人物一致性未复核',
  }
  return codes.map((code) => labels[code] || code).join(' / ')
}

function formatRegressionReviewEvidenceGaps(
  gaps: Array<{ code: string; label: string; message: string }>,
): string {
  if (!gaps.length) return '已补齐'
  return gaps.map((gap) => gap.label || gap.code).join(' / ')
}

function findRegressionExportRecord(exportId: number | null): ExportRecordDTO | null {
  if (!exportId) return null
  return exportHistory.value.find((item) => item.id === exportId) || null
}

function syncRegressionTagForm(exportId: number | null, force = false): void {
  const record = findRegressionExportRecord(exportId)
  const sample = qualityRegression.value?.items.find((item) => item.exportId === exportId)
  if (!record && !sample) {
    regressionTagDraft.value = []
    regressionTagNote.value = ''
    regressionTagTargetExportId.value = null
    syncedRegressionTagExportId = null
    return
  }
  const targetExportId = record?.id || sample?.exportId || null
  if (!force && syncedRegressionTagExportId === targetExportId) return

  const tags =
    record?.config?.finalQualityRegression?.tags ||
    record?.config?.regressionTags ||
    sample?.coverageTags ||
    []
  regressionTagDraft.value = tags.filter((tag) =>
    regressionCoverageOptions.some((option) => option.key === tag),
  )
  regressionTagNote.value = record?.config?.finalQualityRegression?.note || ''
  regressionTagConfirmationToken.value = ''
  regressionTagTargetExportId.value = targetExportId
  syncedRegressionTagExportId = targetExportId
}

function syncDefaultRegressionTagTarget(force = false): void {
  const defaultExportId = latestExport.value?.id || regressionTagTargets.value[0]?.exportId || null
  syncRegressionTagForm(defaultExportId, force)
}

function resolveReviewEvidence(
  report: FinalQualityReportDTO | null,
  key: 'visual' | 'subtitle' | 'audio' | 'characterConsistency',
): { reviewed: boolean; notApplicable: boolean; note: string } {
  const checklist = report?.reviewChecklist
  if (!checklist) return { reviewed: false, notApplicable: false, note: '' }
  const legacyReviewedKey = `${key}Reviewed` as
    | 'visualReviewed'
    | 'subtitleReviewed'
    | 'audioReviewed'
    | 'characterConsistencyReviewed'
  const evidenceKey = `${key}Evidence` as
    | 'visualEvidence'
    | 'subtitleEvidence'
    | 'audioEvidence'
    | 'characterConsistencyEvidence'
  const evidence = checklist[evidenceKey]
  return {
    reviewed: Boolean(evidence?.reviewed ?? checklist[legacyReviewedKey]),
    notApplicable: Boolean(
      evidence?.notApplicable ??
        checklist[`${key}NotApplicable` as keyof typeof checklist],
    ),
    note: String(evidence?.note || '').trim(),
  }
}

function resolveAudioReviewEvidence(report: FinalQualityReportDTO | null): AudioReviewEvidenceDraft {
  const evidence = report?.reviewChecklist.audioEvidence
  return {
    listeningConfirmed: evidence?.listeningConfirmed === true,
    clarityReviewed: evidence?.clarityReviewed === true,
    loudnessReviewed: evidence?.loudnessReviewed === true,
    clippingReviewed: evidence?.clippingReviewed === true,
    syncReviewed: evidence?.syncReviewed === true,
    syncNotApplicable: evidence?.syncNotApplicable === true,
  }
}

function toggleLatestSyncReviewed(): void {
  if (reviewAudioEvidence.value.syncReviewed) {
    reviewAudioEvidence.value.syncNotApplicable = false
  }
}

function toggleLatestSyncNotApplicable(): void {
  if (reviewAudioEvidence.value.syncNotApplicable) {
    reviewAudioEvidence.value.syncReviewed = false
  }
}

function toggleRegressionSyncReviewed(): void {
  if (regressionReviewAudioEvidence.value.syncReviewed) {
    regressionReviewAudioEvidence.value.syncNotApplicable = false
  }
}

function toggleRegressionSyncNotApplicable(): void {
  if (regressionReviewAudioEvidence.value.syncNotApplicable) {
    regressionReviewAudioEvidence.value.syncReviewed = false
  }
}

function syncLatestQualityReviewForm(force = false): void {
  const report = latestQualityReport.value
  if (!report) {
    syncedLatestQualityReportId = null
    return
  }
  if (!force && syncedLatestQualityReportId === report.id) return

  const visual = resolveReviewEvidence(report, 'visual')
  const subtitle = resolveReviewEvidence(report, 'subtitle')
  const audio = resolveReviewEvidence(report, 'audio')
  const characterConsistency = resolveReviewEvidence(report, 'characterConsistency')
  reviewChecks.value = {
    visualReviewed: visual.reviewed,
    subtitleReviewed: subtitle.reviewed,
    audioReviewed: audio.reviewed,
    characterConsistencyReviewed: characterConsistency.reviewed,
    characterConsistencyNotApplicable: characterConsistency.notApplicable,
  }
  reviewEvidenceNotes.value = {
    visual: visual.note,
    subtitle: subtitle.note,
    audio: audio.note,
    characterConsistency: characterConsistency.note,
  }
  reviewAudioEvidence.value = resolveAudioReviewEvidence(report)
  reviewPlaybackCompleted.value = false
  reviewNote.value = report.reviewNote || ''
  reviewConfirmationToken.value = ''
  syncedLatestQualityReportId = report.id
}

function resetRegressionReviewForm(): void {
  regressionReviewChecks.value = {
    visualReviewed: false,
    subtitleReviewed: false,
    audioReviewed: false,
    characterConsistencyReviewed: false,
    characterConsistencyNotApplicable: false,
  }
  regressionReviewEvidenceNotes.value = {
    visual: '',
    subtitle: '',
    audio: '',
    characterConsistency: '',
  }
  regressionReviewAudioEvidence.value = {
    listeningConfirmed: false,
    clarityReviewed: false,
    loudnessReviewed: false,
    clippingReviewed: false,
    syncReviewed: false,
    syncNotApplicable: false,
  }
  regressionReviewPlaybackCompleted.value = false
  regressionReviewNote.value = ''
  regressionReviewConfirmationToken.value = ''
}

function syncRegressionReviewForm(exportId: number | null, force = false): void {
  const record = findRegressionExportRecord(exportId)
  const sample = qualityRegression.value?.items.find((item) => item.exportId === exportId)
  if (!record && !sample) {
    regressionReviewTargetExportId.value = null
    syncedRegressionReviewExportId = null
    resetRegressionReviewForm()
    return
  }

  const targetExportId = record?.id || sample?.exportId || null
  if (!force && syncedRegressionReviewExportId === targetExportId) return

  regressionReviewTargetExportId.value = targetExportId
  const report = targetExportId
    ? qualityReports.value.find((item) => item.exportId === targetExportId) || null
    : null
  const visual = resolveReviewEvidence(report, 'visual')
  const subtitle = resolveReviewEvidence(report, 'subtitle')
  const audio = resolveReviewEvidence(report, 'audio')
  const audioEvidence = resolveAudioReviewEvidence(report)
  const characterConsistency = resolveReviewEvidence(report, 'characterConsistency')

  regressionReviewChecks.value = {
    visualReviewed: visual.reviewed,
    subtitleReviewed: subtitle.reviewed,
    audioReviewed: audio.reviewed,
    characterConsistencyReviewed: characterConsistency.reviewed,
    characterConsistencyNotApplicable: characterConsistency.notApplicable,
  }
  regressionReviewEvidenceNotes.value = {
    visual: visual.note,
    subtitle: subtitle.note,
    audio: audio.note,
    characterConsistency: characterConsistency.note,
  }
  regressionReviewAudioEvidence.value = audioEvidence
  regressionReviewPlaybackCompleted.value = false
  regressionReviewNote.value = report?.reviewNote || ''
  regressionReviewConfirmationToken.value = ''
  syncedRegressionReviewExportId = targetExportId
}

function syncDefaultRegressionReviewTarget(force = false): void {
  const defaultExportId =
    (qualityRegression.value?.items || []).find(
      (item) =>
        item.reviewEvidenceGaps?.length ||
        !item.reviewDecision ||
        item.reviewDecision === 'rework',
    )?.exportId ||
    regressionSampleRows.value[0]?.exportId ||
    latestExport.value?.id ||
    null
  syncRegressionReviewForm(defaultExportId, force)
}

function focusNextRegressionReviewTarget(): void {
  const rows = regressionSampleRows.value
  const next =
    rows.find((item) => !item.hasQualityReport) ||
    rows.find((item) => item.hasQualityReport && !item.technicalPassed) ||
    rows.find((item) => item.reviewEvidenceGaps.length > 0) ||
    rows.find((item) => item.reviewDecision !== 'approved') ||
    rows[0]
  if (!next) return
  syncRegressionReviewForm(next.exportId, true)
}

function scrollToProductionReadinessSection(selector: string): void {
  const target = document.querySelector<HTMLElement>(selector)
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function focusProductionReadinessAction(
  action: ProductionReadinessDTO['actionQueue'][number],
): void {
  const regressionActions = new Set([
    'complete-ten-final-edit-regression',
    'tag-or-produce-missing-coverage',
    'repair-missing-media',
    'fix-subtitle-cues',
    'regenerate-character-evidence-sample',
    'rerun-market-quality-gates',
  ])
  const complianceActions = new Set([
    'complete-release-compliance-package',
    'complete-platform-evidence',
  ])
  const platformActions = new Set([
    'publish-controlled-episodes',
    'import-platform-metrics',
    'record-revenue-evidence',
  ])

  if (regressionActions.has(action.code)) {
    focusNextRegressionReviewTarget()
    scrollToProductionReadinessSection('#final-quality-regression-gate')
  } else if (complianceActions.has(action.code)) {
    scrollToProductionReadinessSection('#release-compliance-gate')
  } else if (action.code === 'complete-cost-ledger-pricing') {
    scrollToProductionReadinessSection('#cost-ledger-gate')
  } else if (platformActions.has(action.code)) {
    scrollToProductionReadinessSection('#platform-validation-gate')
  } else {
    scrollToProductionReadinessSection('#storage-operations-gate')
  }

  setInfo(`已定位：${action.label}。只定位处理区，不保存、不发布、不启动 Worker 或模型。`)
}

async function refreshProductionReadiness(): Promise<void> {
  if (!projectId.value) {
    productionReadiness.value = null
    return
  }
  productionReadiness.value = await getProjectProductionReadiness(projectId.value).catch(
    () => productionReadiness.value,
  )
}

async function loadPage(): Promise<void> {
  // 导出页先读取“可导出包”，确认所有分镜和主视频是否齐全。
  // 同时读取历史记录，方便用户查看之前的导出结果。
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''
  historyErrorMsg.value = ''

  try {
    setWorkspaceContext({ projectId: projectId.value })
    const pkg = await getProjectExportPackage(projectId.value, episodeNo.value)
    exportPackage.value = pkg
    pageState.value = pkg.totalShots > 0 && pkg.readyShots > 0 ? 'ready' : 'empty'
    try {
      const [history, reports] = await Promise.all([
        listProjectExports(projectId.value),
        listFinalQualityReports(projectId.value),
      ])
      exportHistory.value = history
      qualityReports.value = reports
      marketQualityAudit.value = await getProjectMarketQualityAudit(projectId.value).catch(
        () => null,
      )
      syncLatestQualityReviewForm(true)
      const [ledger, compliance] = await Promise.all([
        getProjectCostLedger(projectId.value),
        getProjectReleaseCompliance(projectId.value).catch(() => null),
      ])
      costLedger.value = ledger
      syncReleaseComplianceForm(compliance)
      qualityRegression.value = await getProjectFinalQualityRegression(projectId.value).catch(
        () => null,
      )
      await refreshProductionReadiness()
      syncDefaultRegressionTagTarget(true)
      syncDefaultRegressionReviewTarget(true)
    } catch (error) {
      exportHistory.value = []
      historyErrorMsg.value = error instanceof Error ? error.message : '导出历史加载失败'
    }
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '导出模块加载失败'
    pageState.value = 'error'
  }
}

async function refreshHistory(): Promise<void> {
  if (!projectId.value) return
  try {
    const [history, reports] = await Promise.all([
      listProjectExports(projectId.value),
      listFinalQualityReports(projectId.value),
    ])
    exportHistory.value = history
    qualityReports.value = reports
    marketQualityAudit.value = await getProjectMarketQualityAudit(projectId.value).catch(
      () => null,
    )
    syncLatestQualityReviewForm()
    const [ledger, compliance] = await Promise.all([
      getProjectCostLedger(projectId.value),
      getProjectReleaseCompliance(projectId.value).catch(() => null),
    ])
    costLedger.value = ledger
    syncReleaseComplianceForm(compliance)
    qualityRegression.value = await getProjectFinalQualityRegression(projectId.value).catch(
      () => null,
    )
    await refreshProductionReadiness()
    syncRegressionTagForm(regressionTagTargetExportId.value || latestExport.value?.id || null)
    syncRegressionReviewForm(
      regressionReviewTargetExportId.value ||
        regressionSampleRows.value[0]?.exportId ||
        latestExport.value?.id ||
        null,
    )
    historyErrorMsg.value = ''
    if (['queued', 'running'].includes(exportHistory.value[0]?.status || '')) {
      startExportPolling()
    }
  } catch (error) {
    historyErrorMsg.value = error instanceof Error ? error.message : '导出历史加载失败'
  }
}

async function saveCompliance(): Promise<void> {
  if (!releaseCompliance.value?.exportId || isSavingCompliance.value) return
  isSavingCompliance.value = true
  errorMsg.value = ''
  try {
    const updated = await saveExportReleaseCompliance(releaseCompliance.value.exportId, {
      aiDisclosure: {
        isAiGenerated: true,
        disclosureConfirmed: complianceConfirmed.value,
        label: complianceLabel.value.trim() || null,
        platformEvidence: resolvePlatformEvidencePayload(),
      },
      platforms: releaseCompliance.value.platforms,
      confirm: true,
      confirmationToken: complianceConfirmationToken.value.trim(),
    })
    syncReleaseComplianceForm(updated)
    await refreshProductionReadiness()
    complianceConfirmationToken.value = ''
    setInfo('发布合规包已更新，平台规则仍需发布当天人工核验。')
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '保存发布合规信息失败'
  } finally {
    isSavingCompliance.value = false
  }
}

async function saveSelectedRegressionTags(): Promise<void> {
  const targetExportId = regressionTagTargetExportId.value
  if (!targetExportId || isSavingRegressionTags.value) return
  isSavingRegressionTags.value = true
  errorMsg.value = ''
  try {
    const updated = await saveExportFinalQualityRegressionTags(targetExportId, {
      tags: regressionTagDraft.value,
      note: regressionTagNote.value.trim() || null,
      confirm: true,
      confirmationToken:
        regressionTagConfirmationToken.value.trim() as 'CONFIRM_FINAL_QUALITY_REGRESSION_TAGS',
    })
    exportHistory.value = exportHistory.value.map((item) =>
      item.id === updated.id ? updated : item,
    )
    if (projectId.value) {
      qualityRegression.value = await getProjectFinalQualityRegression(projectId.value).catch(
        () => qualityRegression.value,
      )
      await refreshProductionReadiness()
    }
    syncRegressionTagForm(updated.id, true)
    syncRegressionReviewForm(regressionReviewTargetExportId.value || updated.id, true)
    setInfo('终剪回归覆盖标签已保存；这只更新人工标注，不启动 Worker 或模型。')
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '保存终剪回归覆盖标签失败'
  } finally {
    isSavingRegressionTags.value = false
  }
}

function stopExportPolling(): void {
  if (exportPollTimer !== null) {
    window.clearInterval(exportPollTimer)
    exportPollTimer = null
  }
}

function startExportPolling(): void {
  // 导出是后台 FFmpeg 任务，页面每 2 秒刷新一次历史记录。
  // completed/blocked/failed 后停止轮询。
  stopExportPolling()
  exportPollTimer = window.setInterval(async () => {
    await refreshHistory()
    const status = latestExport.value?.status
    if (status === 'completed' || status === 'blocked' || status === 'failed') {
      stopExportPolling()
      pageState.value = 'ready'
      setInfo(
        status === 'completed'
          ? '混合成片已完成，可直接播放或下载。'
          : status === 'blocked'
            ? '成片已生成，但质量门禁阻止完成，请查看问题镜头并返工。'
            : '混合成片失败，请重试。',
        status === 'completed' ? 'success' : 'warning',
      )
    }
  }, 2000)
}

async function handleExport(): Promise<void> {
  // 创建导出记录后立即返回，真正的混合成片在后端异步执行。
  // 所以这里不能把“接口返回成功”理解成“MP4 已经生成完成”。
  if (!projectId.value || !canExport.value || pageState.value === 'exporting') return

  pageState.value = 'exporting'
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const record = await createProjectExport(projectId.value, {
      episodeNo: episodeNo.value,
      format: verticalTemplate.format,
      resolution: verticalTemplate.resolution,
      frameRate: verticalTemplate.frameRate,
      burnSubtitle: true,
    })
    exportHistory.value = [record, ...exportHistory.value.filter((item) => item.id !== record.id)]
    await refreshHistory()
    setInfo(`导出已生成，记录 #${record.id} 已写入历史`)
    pageState.value = 'ready'
    startExportPolling()
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '导出失败'
    pageState.value =
      exportPackage.value && exportPackage.value.totalShots > 0 && exportPackage.value.readyShots > 0
        ? 'ready'
        : 'empty'
  }
}

async function createLatestQualityReport(): Promise<void> {
  if (!latestExport.value || latestExport.value.status !== 'completed') return
  errorMsg.value = ''
  try {
    const report = await createExportQualityReport(latestExport.value.id)
    qualityReports.value = [
      report,
      ...qualityReports.value.filter((item) => item.exportId !== report.exportId),
    ]
    syncLatestQualityReviewForm(true)
    syncRegressionReviewForm(report.exportId, true)
    setInfo('技术质检报告已生成，请完成画面、字幕和音频复核。')
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '生成质量报告失败'
  }
}

async function createRegressionSampleQualityReport(): Promise<void> {
  if (!regressionReviewTargetExport.value || !canCreateRegressionSampleReport.value) return
  isCreatingRegressionSampleReport.value = true
  errorMsg.value = ''
  try {
    const report = await createExportQualityReport(regressionReviewTargetExport.value.id)
    qualityReports.value = [
      report,
      ...qualityReports.value.filter((item) => item.exportId !== report.exportId),
    ]
    syncLatestQualityReviewForm(true)
    if (projectId.value) {
      qualityRegression.value = await getProjectFinalQualityRegression(projectId.value).catch(
        () => qualityRegression.value,
      )
      await refreshProductionReadiness()
    }
    syncRegressionReviewForm(report.exportId, true)
    setInfo(
      `Export #${report.exportId} 技术质量报告已生成；本操作只检查这一条已完成导出，不启动 Worker 或模型。`,
    )
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '生成选中样本技术质量报告失败'
  } finally {
    isCreatingRegressionSampleReport.value = false
  }
}

async function saveLatestQualityReview(decision: 'approved' | 'rework'): Promise<void> {
  if (!latestQualityReport.value || isSavingReview.value) return
  isSavingReview.value = true
  errorMsg.value = ''
  try {
    const report = await reviewFinalQualityReport(latestQualityReport.value.id, {
      decision,
      checklist: {
        ...reviewChecks.value,
        visualNote: reviewEvidenceNotes.value.visual.trim(),
        subtitleNote: reviewEvidenceNotes.value.subtitle.trim(),
        audioNote: reviewEvidenceNotes.value.audio.trim(),
        audioEvidence: {
          reviewed: reviewChecks.value.audioReviewed,
          listeningConfirmed: reviewAudioEvidence.value.listeningConfirmed,
          clarityReviewed: reviewAudioEvidence.value.clarityReviewed,
          loudnessReviewed: reviewAudioEvidence.value.loudnessReviewed,
          clippingReviewed: reviewAudioEvidence.value.clippingReviewed,
          syncReviewed: reviewAudioEvidence.value.syncReviewed,
          syncNotApplicable: reviewAudioEvidence.value.syncNotApplicable,
          note: reviewEvidenceNotes.value.audio.trim(),
        },
        characterConsistencyNote: reviewEvidenceNotes.value.characterConsistency.trim(),
        characterConsistencyEvidence: {
          reviewed: reviewChecks.value.characterConsistencyReviewed,
          notApplicable: reviewChecks.value.characterConsistencyNotApplicable,
          note: reviewEvidenceNotes.value.characterConsistency.trim(),
        },
      },
      note: reviewNote.value,
      confirm: decision === 'approved',
      confirmationToken: reviewConfirmationToken.value.trim(),
    })
    qualityReports.value = [
      report,
      ...qualityReports.value.filter((item) => item.id !== report.id),
    ]
    syncLatestQualityReviewForm(true)
    setInfo(
      decision === 'approved'
        ? '人工签核已通过：当前成片成为可发布候选。'
        : '已标记返工，请回到成片编辑处理问题。',
      decision === 'approved' ? 'success' : 'warning',
    )
    if (decision === 'approved') {
      reviewConfirmationToken.value = ''
    }
    await refreshProductionReadiness()
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '保存人工签核失败'
  } finally {
    isSavingReview.value = false
  }
}

async function saveRegressionSampleReview(decision: 'approved' | 'rework'): Promise<void> {
  if (!regressionReviewTargetReport.value || isSavingRegressionSampleReview.value) return
  isSavingRegressionSampleReview.value = true
  errorMsg.value = ''
  try {
    const report = await reviewFinalQualityReport(regressionReviewTargetReport.value.id, {
      decision,
      checklist: {
        ...regressionReviewChecks.value,
        visualNote: regressionReviewEvidenceNotes.value.visual.trim(),
        subtitleNote: regressionReviewEvidenceNotes.value.subtitle.trim(),
        audioNote: regressionReviewEvidenceNotes.value.audio.trim(),
        audioEvidence: {
          reviewed: regressionReviewChecks.value.audioReviewed,
          listeningConfirmed: regressionReviewAudioEvidence.value.listeningConfirmed,
          clarityReviewed: regressionReviewAudioEvidence.value.clarityReviewed,
          loudnessReviewed: regressionReviewAudioEvidence.value.loudnessReviewed,
          clippingReviewed: regressionReviewAudioEvidence.value.clippingReviewed,
          syncReviewed: regressionReviewAudioEvidence.value.syncReviewed,
          syncNotApplicable: regressionReviewAudioEvidence.value.syncNotApplicable,
          note: regressionReviewEvidenceNotes.value.audio.trim(),
        },
        characterConsistencyNote: regressionReviewEvidenceNotes.value.characterConsistency.trim(),
        characterConsistencyEvidence: {
          reviewed: regressionReviewChecks.value.characterConsistencyReviewed,
          notApplicable: regressionReviewChecks.value.characterConsistencyNotApplicable,
          note: regressionReviewEvidenceNotes.value.characterConsistency.trim(),
        },
      },
      note: regressionReviewNote.value,
      confirm: decision === 'approved',
      confirmationToken: regressionReviewConfirmationToken.value.trim(),
    })
    qualityReports.value = [
      report,
      ...qualityReports.value.filter((item) => item.id !== report.id),
    ]
    syncLatestQualityReviewForm(true)
    if (projectId.value) {
      qualityRegression.value = await getProjectFinalQualityRegression(projectId.value).catch(
        () => qualityRegression.value,
      )
      await refreshProductionReadiness()
    }
    syncRegressionReviewForm(report.exportId, true)
    setInfo(
      decision === 'approved'
        ? `Export #${report.exportId} 单条样本人工复核已通过；仍需整体回归达标后再进入发布候选判断。`
        : `Export #${report.exportId} 已标记返工；本操作只保存人工证据，不启动 Worker 或模型。`,
      decision === 'approved' ? 'success' : 'warning',
    )
    if (decision === 'approved') {
      regressionReviewConfirmationToken.value = ''
    }
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '保存单条样本人工复核失败'
  } finally {
    isSavingRegressionSampleReview.value = false
  }
}

function statusClass(status: ExportPackageItemDTO['exportStatus']): string {
  return status === 'missing-video' ? 'status-chip missing' : 'status-chip ready'
}

function exportRecordStatusClass(status: string): string {
  if (status === 'completed') return 'ready'
  if (status === 'failed' || status === 'blocked') return 'missing'
  return 'pending'
}

function exportRecordStatusLabel(status: string): string {
  if (status === 'completed') return '已完成'
  if (status === 'blocked') return '需返工'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已取消'
  if (status === 'running') return '处理中'
  if (status === 'queued') return '排队中'
  return status
}

function exportRecordActionLabel(status: string): string {
  if (status === 'completed') return '查看文件'
  if (status === 'blocked') return '查看报告'
  if (status === 'failed') return '导出失败'
  if (status === 'canceled') return '已取消'
  if (status === 'running') return '后台处理中'
  if (status === 'queued') return '等待开始'
  return '状态待确认'
}

function statusLabel(status: ExportPackageItemDTO['exportStatus']): string {
  return status === 'ready' ? '已就绪' : '缺少最终视频'
}

watch(
  () => route.query.projectId,
  () => {
    void loadPage()
  },
)

onMounted(() => {
  void loadPage()
})

onBeforeUnmount(() => {
  stopExportPolling()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少项目上下文</h2>
        <p class="state-desc">导出模块是项目级页面，请从具体项目工作区进入。</p>
        <button class="primary-btn" type="button" @click="goDashboard">返回项目页</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载导出模块...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">导出模块加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="flex flex-wrap gap-3">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="goWorkspace">返回工作区</button>
        </div>
      </div>
    </section>

    <div v-else class="export-page">
      <div class="page-top export-hero">
        <div>
          <div class="page-context">
            <span>项目 #{{ projectId }}</span>
            <span class="page-context-dot"></span>
            <span>交付工作台</span>
          </div>
          <h1 class="page-title">合成与导出</h1>
          <p class="page-subtitle">
            从素材完整性到发布合规，在一个工作台里完成成片交付。
          </p>
          <div v-if="productionReadiness" class="delivery-hero-state">
            <span class="delivery-hero-state-label">当前交付状态</span>
            <strong>{{ productionReadinessStatusText }}</strong>
            <span>{{ productionReadiness.blockers.length }} 项待处理</span>
          </div>
        </div>
        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goWorkspace">
            <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
            返回工作区
          </button>
          <button class="ghost-btn" type="button" @click="loadPage">
            <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
            刷新清单
          </button>
        </div>
      </div>

      <div v-if="errorMsg" class="message message--global error" role="alert" aria-live="assertive">
        <span class="material-symbols-outlined message-icon" aria-hidden="true">error</span>
        <span class="message-copy">{{ errorMsg }}</span>
        <div class="message-actions">
          <button
            class="message-close"
            type="button"
            aria-label="关闭错误提示"
            @click="errorMsg = ''"
          >
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
      </div>
      <div
        v-if="infoMsg"
        class="message message--global"
        :class="infoTone"
        role="status"
        aria-live="polite"
      >
        <span class="material-symbols-outlined message-icon" aria-hidden="true">
          {{ infoTone === 'warning' ? 'priority_high' : 'check_circle' }}
        </span>
        <span class="message-copy">{{ infoMsg }}</span>
        <div class="message-actions">
          <button
            v-if="infoTone === 'warning'"
            class="message-action ghost-btn compact-btn"
            type="button"
            @click="goFinalEdit"
          >
            <span class="material-symbols-outlined" aria-hidden="true">movie_edit</span>
            返回成片编辑
          </button>
          <button
            class="message-close"
            type="button"
            aria-label="关闭提示"
            @click="infoMsg = ''"
          >
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
      </div>
      <div v-if="exportPackage && !exportPackage.canExport" class="message error">
        {{ exportPackage.blockingIssues[0]?.message || '当前项目素材尚未补齐，暂时不能导出。' }}
      </div>

      <div class="summary-grid">
        <section class="summary-card highlight">
          <span class="summary-label">导出覆盖分镜</span>
          <strong class="summary-value">{{ exportPackage?.readyShots || 0 }} / {{ exportPackage?.totalShots || 0 }}</strong>
          <p class="summary-help">只有已确认最终视频的分镜会进入本次导出。</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">缺失分镜</span>
          <strong class="summary-value">{{ exportPackage?.missingShots || 0 }}</strong>
          <p class="summary-help">所有分镜都确认最终视频后才能导出。</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">预计时长</span>
          <strong class="summary-value">{{ formatDuration(exportPackage?.totalDurationSeconds) }}</strong>
          <p class="summary-help">按当前已就绪分镜的时长合计估算。</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">未拆分镜场景</span>
          <strong class="summary-value">{{ exportPackage?.missingStoryboardScenes || 0 }}</strong>
          <p class="summary-help">场景需先完成拆镜，才能进入完整导出清单。</p>
        </section>
      </div>

      <section v-if="productionReadiness" class="panel production-gate-panel">
        <div class="panel-head">
          <div>
            <h2>生产发布总闸门</h2>
            <p class="panel-sub">
              把终剪回归、机器质检、发布合规、存储、成本和平台收入证据统一收敛成下一步。
            </p>
          </div>
          <span
            class="status-chip"
            :class="productionReadiness.releaseCandidateReady ? 'ready' : 'missing'"
          >
            {{ productionReadinessStatusText }}
          </span>
        </div>

        <div class="message warning production-gate-disclaimer">
          该总闸门不会替代人工审核、平台审核或收入证明；只有真实证据齐全后才会放行。
        </div>

        <div class="production-gate-summary">
          <div class="production-gate-kpi">
            <span class="summary-label">发布候选</span>
            <strong>{{ productionReadiness.releaseCandidateReady ? '可试发布' : '阻塞' }}</strong>
            <p>{{ productionReadiness.releaseCandidateReady ? '技术与内部门禁已齐' : '仍需处理证据缺口' }}</p>
          </div>
          <div class="production-gate-kpi">
            <span class="summary-label">收入验证</span>
            <strong>{{ productionReadiness.stableRevenueReady ? '已有证据' : '未完成' }}</strong>
            <p>{{ productionReadiness.stableRevenueReady ? '平台和收入证据已入库' : '不能宣称稳定赚钱' }}</p>
          </div>
          <div class="production-gate-kpi">
            <span class="summary-label">阻塞项</span>
            <strong>{{ productionReadiness.blockers.length }}</strong>
            <p>按 actionQueue 从上到下处理。</p>
          </div>
        </div>

        <div class="production-stage-grid">
          <div
            v-for="stage in productionReadinessStageRows"
            :key="stage.key"
            class="production-stage-row"
            :class="{ passed: stage.passed }"
          >
            <strong>{{ stage.label }}</strong>
            <span>{{ stage.passed ? '通过' : `阻塞 ${stage.blockerCount}` }}</span>
          </div>
        </div>

        <div v-if="productionReadiness.actionQueue.length" class="production-action-list">
          <div class="platform-evidence-title">
            <strong>下一步处理</strong>
            <span>{{ productionReadiness.actionQueue.length }} 项</span>
          </div>
          <div
            v-for="action in productionReadiness.actionQueue.slice(0, 3)"
            :key="action.code"
            class="production-action-row"
          >
            <div>
              <strong>{{ action.label }}</strong>
              <p>{{ action.message }}</p>
            </div>
            <button
              class="ghost-btn compact-btn"
              type="button"
              @click="focusProductionReadinessAction(action)"
            >
              定位处理区
            </button>
          </div>
          <details
            v-if="productionReadiness.actionQueue.length > 3"
            class="production-action-more"
          >
            <summary>
              <span>查看其余处理项</span>
              <span>{{ productionReadiness.actionQueue.length - 3 }} 项</span>
            </summary>
            <div
              v-for="action in productionReadiness.actionQueue.slice(3)"
              :key="action.code"
              class="production-action-row production-action-row--secondary"
            >
              <div>
                <strong>{{ action.label }}</strong>
                <p>{{ action.message }}</p>
              </div>
              <button
                class="ghost-btn compact-btn"
                type="button"
                @click="focusProductionReadinessAction(action)"
              >
                定位处理区
              </button>
            </div>
          </details>
        </div>

        <p class="history-sub production-gate-footnote">
          更新时间：{{ productionReadiness.generatedAt }} · {{ productionReadiness.disclaimer }} ·
          只定位处理区，不保存、不发布、不启动 Worker 或模型。
        </p>
      </section>

      <section v-if="marketQualityAudit" id="market-quality-gate" class="panel market-quality-panel">
        <div class="panel-head">
          <div>
            <h2>六维机器预审</h2>
            <p class="panel-sub">
              基于真实导出对象的只读审计；当前样本：Export #{{ latestMarketQualityItem?.exportId || '-' }}。
            </p>
          </div>
          <span
            class="status-chip"
            :class="latestMarketQualityItem?.audit?.publishCandidate?.machinePassed ? 'ready' : 'missing'"
          >
            {{ latestMarketQualityItem?.audit?.publishCandidate?.status || '暂无样本' }}
          </span>
        </div>

        <div class="message warning market-quality-disclaimer">
          机器预审不能替代真人完整播放和平台审核；也不能替代内容审美、人物连续性判断。
        </div>

        <div class="summary-grid compact market-quality-summary">
          <div class="summary-card">
            <span class="summary-label">可审计样本</span>
            <strong class="summary-value">
              {{ marketQualityAudit.summary.auditableSampleCount }} /
              {{ marketQualityAudit.summary.requiredSampleCount }}
            </strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">技术门禁通过</span>
            <strong class="summary-value">
              {{ marketQualityAudit.summary.technicalProxyPassedCount }} /
              {{ marketQualityAudit.summary.requiredSampleCount }}
            </strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">当前机器分数</span>
            <strong class="summary-value">{{ latestMarketQualityItem?.audit?.overallScore ?? '-' }}</strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">发布候选机器状态</span>
            <strong class="summary-value compact-value">
              {{ latestMarketQualityItem?.audit?.publishCandidate?.machinePassed ? '机器通过' : '机器阻塞' }}
            </strong>
          </div>
        </div>

        <details v-if="latestMarketQualityItem" class="market-quality-details">
          <summary>
            <span>查看六项机器指标</span>
            <span>当前样本 Export #{{ latestMarketQualityItem.exportId }}</span>
          </summary>
          <div class="market-quality-grid">
          <article class="market-quality-card">
            <div class="market-quality-card-head">
              <strong>1. 画面比例与帧完整性</strong>
              <span :class="marketDimensionPassed(latestMarketQualityItem, 'media') ? 'passed-text' : 'blocked-text'">
                {{ marketDimensionStatus(latestMarketQualityItem, 'media') }}
              </span>
            </div>
            <p>规格：{{ marketObserved(latestMarketQualityItem, 'media', 'width') }} x {{ marketObserved(latestMarketQualityItem, 'media', 'height') }} · {{ marketObserved(latestMarketQualityItem, 'media', 'frameRate') }} fps</p>
            <p>黑边：{{ marketObserved(latestMarketQualityItem, 'media', 'blackBarDetected') }} · 冻结帧：{{ marketObserved(latestMarketQualityItem, 'media', 'freezeDetected') }} · 跳帧：{{ marketObserved(latestMarketQualityItem, 'media', 'droppedFrameRisk') }}</p>
          </article>

          <article class="market-quality-card">
            <div class="market-quality-card-head">
              <strong>2. 字幕文字与时间轴</strong>
              <span :class="marketDimensionPassed(latestMarketQualityItem, 'subtitle') ? 'passed-text' : 'blocked-text'">
                {{ marketDimensionStatus(latestMarketQualityItem, 'subtitle') }}
              </span>
            </div>
            <p>实际 cue：{{ marketRecordValue(latestMarketQualityItem.subtitle, 'cueCount') }} · 预期 cue：{{ marketRecordValue(latestMarketQualityItem.subtitle, 'expectedCueCount') }}</p>
            <p>字号：{{ marketDimension(latestMarketQualityItem, 'subtitle')?.fontSize ?? '-' }} · 底部安全距：{{ marketDimension(latestMarketQualityItem, 'subtitle')?.marginV ?? '-' }}</p>
          </article>

          <article class="market-quality-card">
            <div class="market-quality-card-head">
              <strong>3. 人物一致性机器门禁</strong>
              <span :class="marketDimensionPassed(latestMarketQualityItem, 'characters') ? 'passed-text' : 'blocked-text'">
                {{ marketDimensionStatus(latestMarketQualityItem, 'characters') }}
              </span>
            </div>
            <p>核验镜头：{{ marketDimension(latestMarketQualityItem, 'characters')?.checkedClipCount ?? '-' }} · 版本缺口：{{ marketDimension(latestMarketQualityItem, 'characters')?.missingVersionCount ?? '-' }}</p>
            <p>基线缺口：{{ marketDimension(latestMarketQualityItem, 'characters')?.missingBaselineCount ?? '-' }} · 版本不一致：{{ marketDimension(latestMarketQualityItem, 'characters')?.mismatchCount ?? '-' }}</p>
          </article>

          <article class="market-quality-card">
            <div class="market-quality-card-head">
              <strong>4. 音频机器检测</strong>
              <span :class="marketDimensionPassed(latestMarketQualityItem, 'audio') ? 'passed-text' : 'blocked-text'">
                {{ marketDimensionStatus(latestMarketQualityItem, 'audio') }}
              </span>
            </div>
            <p>采样率：{{ marketObserved(latestMarketQualityItem, 'media', 'audioSampleRate') }} Hz · LUFS：{{ marketRecordValue(latestMarketQualityItem.audio, 'integratedLufs') }}</p>
            <p>峰值：{{ marketRecordValue(latestMarketQualityItem.audio, 'truePeakDbtp') }} dBTP · 削波样本：{{ marketRecordValue(latestMarketQualityItem.audio, 'clippedSamples') }} · 对白活动：{{ marketRecordValue(latestMarketQualityItem.audio, 'speechCoverageRatio') }}</p>
          </article>

          <article class="market-quality-card">
            <div class="market-quality-card-head">
              <strong>5. 开头钩子与镜头节奏</strong>
              <span :class="marketDimensionPassed(latestMarketQualityItem, 'pacing') ? 'passed-text' : 'blocked-text'">
                {{ marketDimensionStatus(latestMarketQualityItem, 'pacing') }}
              </span>
            </div>
            <p>首个对白：{{ marketDimension(latestMarketQualityItem, 'hook')?.firstSpeechStartSeconds ?? '-' }} 秒</p>
            <p>镜头数：{{ marketDimension(latestMarketQualityItem, 'pacing')?.shotCount ?? '-' }} · 镜头密度：{{ marketDimension(latestMarketQualityItem, 'pacing')?.shotDensityPerTenSeconds ?? '-' }} / 10 秒</p>
          </article>

          <article class="market-quality-card market-quality-card-emphasis">
            <div class="market-quality-card-head">
              <strong>6. 发布候选标准</strong>
              <span :class="latestMarketQualityItem.audit?.publishCandidate?.machinePassed ? 'passed-text' : 'blocked-text'">
                {{ latestMarketQualityItem.audit?.publishCandidate?.machinePassed ? '机器通过' : '机器阻塞' }}
              </span>
            </div>
            <p>{{ latestMarketQualityItem.audit?.publishCandidate?.status || '暂无机器结论' }}</p>
            <p v-for="blocker in (latestMarketQualityItem.blockers || []).slice(0, 3)" :key="blocker.code" class="blocked-text">
              {{ blocker.message }}
            </p>
          </article>
          </div>
        </details>

        <details
          v-if="machineAuditRows.length"
          class="machine-audit-details"
        >
          <summary>
            <span>机器审计样本清单</span>
            <span>{{ machineAuditRows.length }} 条 · 只读</span>
          </summary>
          <div class="machine-audit-list">
          <p class="history-sub">
            先处理机器阻塞，再进入真人审核。以下检查覆盖画面比例/黑边/跳帧、音频指标、字幕文字与时间轴、角色版本证据和发布材料；不会自动修复媒体。
          </p>
          <div
            v-for="row in machineAuditRows"
            :key="row.exportId"
            class="machine-audit-row"
            :class="{ blocked: !row.technicalPassed }"
          >
            <div class="machine-audit-row-head">
              <strong>Export #{{ row.exportId }}</strong>
              <span :class="row.technicalPassed ? 'passed-text' : 'blocked-text'">
                {{ row.statusText }}
              </span>
            </div>
            <div class="machine-audit-checks">
              <span
                v-for="check in row.checks"
                :key="check.key"
                class="machine-audit-check"
                :class="{ passed: check.passed }"
              >
                {{ check.label }} {{ check.passed ? '通过' : '阻塞' }}
              </span>
            </div>
            <p v-if="row.blockerText" class="history-sub machine-audit-blockers">
              {{ row.blockerText }}
            </p>
          </div>
          </div>
        </details>

        <p class="history-sub market-quality-footnote">
          审计生成时间：{{ marketQualityAudit.generatedAt }} · 报告版本：{{ marketQualityAudit.benchmarkVersion }} · 该区域不会自动批准、发布、启动 Worker 或调用模型。
        </p>
      </section>

      <section v-if="exportPackage?.incompleteScenes.length" class="panel scene-gap-panel">
        <div class="panel-head">
          <div>
            <h2>尚未拆分镜的场景</h2>
            <p class="panel-sub">这些场景不完整，当前导出已被阻止。</p>
          </div>
          <span class="panel-tag">{{ exportPackage.incompleteScenes.length }} 个</span>
        </div>
        <div class="scene-gap-list">
          <span v-for="scene in exportPackage.incompleteScenes" :key="scene.sceneId" class="scene-gap-item">
            Scene {{ scene.sceneNo }} · {{ scene.sceneTitle || '未命名场景' }}
          </span>
        </div>
      </section>

      <div class="main-grid primary-workbench-grid">
        <section class="panel primary-export-panel">
          <div class="panel-head">
            <div>
              <h2>导出参数</h2>
              <p class="panel-sub">已锁定为统一的竖屏生产规格，避免项目中混入横屏或不兼容编码。</p>
            </div>
            <span class="panel-tag">固定规格</span>
          </div>

          <div class="field-grid">
            <div class="field">
              <span>输出容器</span>
              <strong class="field-input static-value">{{ verticalTemplate.format }}</strong>
            </div>

            <div class="field">
              <span>画幅与分辨率</span>
              <strong class="field-input static-value">{{ verticalTemplate.resolution }}</strong>
            </div>

            <div class="field">
              <span>帧率</span>
              <strong class="field-input static-value">{{ verticalTemplate.frameRate }} fps</strong>
            </div>

            <label class="field field-toggle">
              <span>字幕烧录</span>
              <button
                class="toggle-btn"
                :class="{ active: burnSubtitle }"
                type="button"
                aria-label="正式竖屏导出固定烧录字幕"
                @click="burnSubtitle = true"
              >
                <span class="toggle-dot"></span>
              </button>
              <strong class="mt-2 text-xs text-primary">正式导出固定开启</strong>
            </label>
          </div>

          <div class="export-action">
            <div>
              <strong class="export-action-title">{{ exportButtonText }}</strong>
              <p class="export-action-sub">{{ exportHint }}</p>
            </div>
            <button class="primary-btn wide" type="button" :disabled="!canExport || pageState === 'exporting'" @click="handleExport">
              <span class="material-symbols-outlined" aria-hidden="true">
                {{ pageState === 'exporting' ? 'progress_activity' : 'movie' }}
              </span>
              {{ exportButtonText }}
            </button>
          </div>

          <div v-if="pageState === 'empty'" class="empty-box">
            <h3>当前项目还没有可导出的最终视频</h3>
            <p>
              你可以先回到场景 / 分镜工作区，继续补完静帧和最终视频，再回来发起导出。
            </p>
            <button class="ghost-btn" type="button" @click="goWorkspace">回到工作区继续处理</button>
          </div>

          <div v-if="latestExport" class="latest-export">
            <div class="latest-export-head">
              <h3>最近一次导出</h3>
              <span class="status-chip" :class="exportRecordStatusClass(latestExport.status)">{{ exportRecordStatusLabel(latestExport.status) }}</span>
            </div>
            <video
              v-if="(latestExport.status === 'completed' || latestExport.status === 'blocked') && !latestExport.videoUrl?.startsWith('pending://')"
              :src="getPlaybackUrl(latestExport)"
              controls
              playsinline
              @ended="reviewPlaybackCompleted = true"
              class="latest-video"
            ></video>
            <p v-else-if="latestExport.status !== 'blocked'" class="history-sub">后台任务状态：{{ exportRecordStatusLabel(latestExport.status) }}，完成后会自动出现播放器。</p>
            <div class="latest-meta">
              <span>记录 #{{ latestExport.id }}</span>
              <span>{{ formatDuration(latestExport.durationSeconds) }}</span>
              <span>{{ latestExport.config?.resolution || '-' }}</span>
            </div>

            <section
              v-if="latestExport.status === 'blocked'"
              class="quality-review quality-review--blocked"
              aria-label="成片质量门禁报告"
            >
              <div class="quality-review-head">
                <div>
                  <h3>成片质量门禁阻止完成</h3>
                  <p>{{ latestExport.config?.cinematicQualityReport?.summary || '成片已保留，但还有问题镜头需要处理。' }}</p>
                </div>
                <span class="status-chip missing">需返工</span>
              </div>
              <div
                v-for="issue in latestExport.config?.cinematicQualityReport?.blockers || []"
                :key="`${issue.code}-${issue.message}`"
                class="message error"
              >
                {{ issue.message }}
              </div>
              <p
                v-for="shot in latestExport.config?.cinematicQualityReport?.issueShots || []"
                :key="`${shot.storyboardId}-${shot.code}`"
                class="message warning"
              >
                分镜 {{ shot.storyboardId }}：{{ shot.message }}
              </p>
              <div class="quality-review-actions">
                <button class="ghost-btn" type="button" @click="goFinalEdit">手动调整后重新导出</button>
                <button class="ghost-btn" type="button" @click="goFinalEdit">按建议重新规划</button>
              </div>
            </section>

            <section
              v-if="latestExport.status === 'completed'"
              class="quality-review"
              aria-label="成片质量签核"
            >
              <div class="quality-review-head">
                <div>
                  <h3>成片质量签核</h3>
                  <p>
                    {{
                      latestQualityReport
                        ? latestQualityReport.releaseStatus === 'release-candidate'
                          ? '技术门禁与人工复核均已通过。'
                          : latestQualityReport.automaticPassed
                            ? '技术门禁已通过，等待人工复核。'
                            : '技术门禁未通过，不能进入人工批准。'
                        : '先生成技术报告，再进行人工复核。'
                    }}
                  </p>
                </div>
                <span
                  class="status-chip"
                  :class="
                    latestQualityReport?.releaseStatus === 'release-candidate'
                      ? 'ready'
                      : latestQualityReport?.automaticPassed
                        ? 'pending'
                        : 'missing'
                  "
                >
                  {{ latestQualityReport?.releaseStatus || '未生成报告' }}
                </span>
              </div>

              <button
                v-if="!latestQualityReport"
                class="ghost-btn"
                type="button"
                @click="createLatestQualityReport"
              >
                生成技术质量报告
              </button>

              <div v-else class="quality-review-body">
                <p
                  v-for="issue in latestQualityReport.automaticReport.blockingIssues || []"
                  :key="issue.code"
                  class="message error"
                >
                  {{ issue.message }}
                </p>

                <div v-if="latestQualityReport.automaticPassed" class="review-checklist">
                  <label>
                    <input v-model="reviewChecks.visualReviewed" type="checkbox" />
                    <span>画面与人物表现已复核</span>
                  </label>
                  <textarea
                    v-model="reviewEvidenceNotes.visual"
                    class="review-note compact"
                    placeholder="记录画面是否拉伸、黑边、跳帧、主体裁切"
                  ></textarea>
                  <label>
                    <input v-model="reviewChecks.subtitleReviewed" type="checkbox" />
                    <span>字幕文本与安全区已复核</span>
                  </label>
                  <textarea
                    v-model="reviewEvidenceNotes.subtitle"
                    class="review-note compact"
                    placeholder="记录字幕准确性、错别字和安全区"
                  ></textarea>
                  <label>
                    <input v-model="reviewChecks.audioReviewed" type="checkbox" />
                    <span>对白、BGM 与音效已复核</span>
                  </label>
                  <textarea
                    v-model="reviewEvidenceNotes.audio"
                    class="review-note compact"
                    placeholder="记录对白清晰度、响度、爆音和对嘴"
                  ></textarea>
                  <p class="history-sub audio-review-hint">完整播放到结尾后才能勾选听感确认。</p>
                  <div class="review-subchecks">
                    <label>
                      <input
                        v-model="reviewAudioEvidence.listeningConfirmed"
                        type="checkbox"
                        :disabled="
                          !reviewPlaybackCompleted && !reviewAudioEvidence.listeningConfirmed
                        "
                      />
                      <span>实际完整播放过成片</span>
                    </label>
                    <label>
                      <input v-model="reviewAudioEvidence.clarityReviewed" type="checkbox" />
                      <span>对白清晰，无明显底噪</span>
                    </label>
                    <label>
                      <input v-model="reviewAudioEvidence.loudnessReviewed" type="checkbox" />
                      <span>响度与 BGM/SFX 平衡</span>
                    </label>
                    <label>
                      <input v-model="reviewAudioEvidence.clippingReviewed" type="checkbox" />
                      <span>没有爆音或明显失真</span>
                    </label>
                    <label>
                      <input
                        v-model="reviewAudioEvidence.syncReviewed"
                        type="checkbox"
                        @change="toggleLatestSyncReviewed"
                      />
                      <span>对白与画面同步</span>
                    </label>
                    <label>
                      <input
                        v-model="reviewAudioEvidence.syncNotApplicable"
                        type="checkbox"
                        @change="toggleLatestSyncNotApplicable"
                      />
                      <span>对白同步不适用（无可见说话人物）</span>
                    </label>
                  </div>
                  <label>
                    <input v-model="reviewChecks.characterConsistencyReviewed" type="checkbox" />
                    <span>人物一致性已复核</span>
                  </label>
                  <label>
                    <input
                      v-model="reviewChecks.characterConsistencyNotApplicable"
                      type="checkbox"
                    />
                    <span>人物一致性不适用（无实体人物）</span>
                  </label>
                  <textarea
                    v-model="reviewEvidenceNotes.characterConsistency"
                    class="review-note compact"
                    placeholder="记录人物外貌、发型、服装、体型和同屏角色数量"
                  ></textarea>
                  <textarea
                    v-model="reviewNote"
                    class="review-note"
                    placeholder="填写复核结论或返工原因"
                  ></textarea>
                  <label class="review-token-field">
                    <span>批准确认口令</span>
                    <input
                      v-model="reviewConfirmationToken"
                      class="review-token-input"
                      type="text"
                      autocomplete="off"
                      placeholder="APPROVE_FINAL_QUALITY_REVIEW"
                    />
                  </label>
                  <div class="review-actions">
                    <button
                      class="ghost-btn"
                      type="button"
                      :disabled="isSavingReview"
                      @click="saveLatestQualityReview('rework')"
                    >
                      标记返工
                    </button>
                    <button
                      class="primary-btn"
                      type="button"
                      :disabled="!canApproveLatestQuality || isSavingReview"
                      @click="saveLatestQualityReview('approved')"
                    >
                      {{ isSavingReview ? '保存中...' : '批准为可发布候选' }}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section id="storage-operations-gate" class="panel export-history-panel">
          <div class="panel-head">
            <div>
              <h2>导出历史</h2>
              <p class="panel-sub">查看最近导出结果、输出规格与分镜覆盖范围。</p>
            </div>
            <span class="panel-tag">{{ exportHistory.length }} 条</span>
          </div>

          <div v-if="historyErrorMsg" class="message error">
            导出清单可正常使用，但历史记录暂时加载失败：{{ historyErrorMsg }}
          </div>

          <div v-if="exportHistory.length === 0" class="history-empty">还没有导出记录。</div>

          <div v-else class="history-list">
            <article
              v-for="record in visibleExportHistory"
              :key="record.id"
              class="history-item"
              :class="`history-item--${record.status}`"
            >
              <div class="history-main">
                <div class="history-title">
                  <div class="history-identity">
                    <span class="history-type">导出</span>
                    <strong>#{{ record.id }}</strong>
                  </div>
                  <span class="status-chip" :class="exportRecordStatusClass(record.status)">
                    {{ exportRecordStatusLabel(record.status) }}
                  </span>
                </div>
                <div class="history-meta" aria-label="输出规格">
                  <span>{{ record.config?.format || '-' }}</span>
                  <span>{{ record.config?.resolution || '-' }}</span>
                  <span>{{ formatDuration(record.durationSeconds) }}</span>
                </div>
                <div class="history-coverage">
                  <span class="history-coverage-label">分镜覆盖</span>
                  <strong>{{ record.readyCount }} / {{ record.sourceCount }}</strong>
                  <span>已纳入导出包</span>
                </div>
              </div>
              <a v-if="record.status === 'completed'" class="history-link" :href="record.videoUrl" target="_blank" rel="noreferrer">
                {{ exportRecordActionLabel(record.status) }}
              </a>
              <span v-else class="history-link muted">{{ exportRecordActionLabel(record.status) }}</span>
            </article>
          </div>
          <details v-if="olderExportHistory.length" class="history-more">
            <summary>
              <span>
                <strong>更早的导出记录</strong>
                <small>按时间倒序排列</small>
              </span>
              <em>{{ olderExportHistory.length }} 条</em>
            </summary>
            <div class="history-list history-list--older">
              <article
                v-for="record in olderExportHistory"
                :key="record.id"
                class="history-item"
                :class="`history-item--${record.status}`"
              >
                <div class="history-main">
                  <div class="history-title">
                    <div class="history-identity">
                      <span class="history-type">导出</span>
                      <strong>#{{ record.id }}</strong>
                    </div>
                    <span class="status-chip" :class="exportRecordStatusClass(record.status)">
                      {{ exportRecordStatusLabel(record.status) }}
                    </span>
                  </div>
                  <div class="history-meta" aria-label="输出规格">
                    <span>{{ record.config?.format || '-' }}</span>
                    <span>{{ record.config?.resolution || '-' }}</span>
                    <span>{{ formatDuration(record.durationSeconds) }}</span>
                  </div>
                  <div class="history-coverage">
                    <span class="history-coverage-label">分镜覆盖</span>
                    <strong>{{ record.readyCount }} / {{ record.sourceCount }}</strong>
                    <span>已纳入导出包</span>
                  </div>
                </div>
                <a v-if="record.status === 'completed'" class="history-link" :href="record.videoUrl" target="_blank" rel="noreferrer">
                  {{ exportRecordActionLabel(record.status) }}
                </a>
                <span v-else class="history-link muted">{{ exportRecordActionLabel(record.status) }}</span>
              </article>
            </div>
          </details>
        </section>
      </div>

      <section v-if="qualityRegression" id="final-quality-regression-gate" class="panel regression-panel">
        <div class="panel-head">
          <div>
            <h2>10 条终剪回归</h2>
            <p class="panel-sub">
              只统计实际完成或失败的终剪尝试；取消、排队和运行中记录排除，不会自动启动 Worker 或调用模型。
            </p>
          </div>
          <span
            class="status-chip"
            :class="qualityRegression.ready ? 'ready' : 'pending'"
          >
            {{ qualityRegression.status }}
          </span>
        </div>
        <div
          v-if="qualityRegression.blockers.length"
          class="message warning"
        >
          {{ qualityRegression.blockers[0]?.message }}
        </div>
        <div class="summary-grid compact">
          <div class="summary-card">
            <span class="summary-label">回归样本</span>
            <strong class="summary-value">
              {{ qualityRegression.summary.sampleCount }} /
              {{ qualityRegression.summary.requiredSampleCount }}
            </strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">人工批准率</span>
            <strong class="summary-value">{{ regressionApprovalRateText }}</strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">平均耗时</span>
            <strong class="summary-value">
              {{ formatDuration(qualityRegression.summary.averageTurnaroundSeconds) }}
            </strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">单条均摊成本</span>
            <strong class="summary-value">{{ regressionAverageCostText }}</strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">覆盖类型</span>
            <strong class="summary-value">
              {{ qualityRegression.coverage.coveredCount }} /
              {{ qualityRegression.coverage.requiredCount }}
            </strong>
          </div>
        </div>
        <div class="coverage-buckets">
          <span
            v-for="bucket in qualityRegression.coverage.buckets"
            :key="bucket.key"
            class="coverage-chip"
            :class="{ covered: bucket.covered }"
          >
            {{ bucket.label }} {{ bucket.count }}
          </span>
        </div>
        <p
          v-if="qualityRegression.coverage.missingBuckets.length"
          class="history-sub"
        >
          缺少覆盖：{{ regressionMissingCoverageText }}
        </p>
        <div class="production-readiness-card">
          <div class="platform-evidence-title">
            <strong>稳定生产判定</strong>
            <span>{{ qualityRegression.productionReadiness.status }}</span>
          </div>
          <p class="history-sub">
            技术和人工双通过样本：{{ qualityRegression.productionReadiness.passedSampleCount }} /
            {{ qualityRegression.productionReadiness.requiredPassedSampleCount }}
          </p>
          <p
            v-for="blocker in qualityRegression.productionReadiness.blockers.slice(0, 4)"
            :key="blocker.code"
            class="history-sub production-readiness-blocker"
          >
            {{ blocker.message }}
          </p>
          <p
            v-if="!qualityRegression.productionReadiness.blockers.length"
            class="history-sub"
          >
            10 条样本均已通过技术检查和人工复核，可进入小批量生产验证。
          </p>
        </div>
        <div v-if="regressionSampleRows.length" class="regression-gap-summary">
          <div class="platform-evidence-title">
            <strong>缺口摘要</strong>
            <span>只读统计</span>
          </div>
          <div class="regression-gap-grid">
            <div class="regression-gap-card">
              <span>未标记覆盖</span>
              <strong>{{ regressionGapSummary.missingTags }}</strong>
            </div>
            <div class="regression-gap-card warning">
              <span>技术阻塞</span>
              <strong>{{ regressionGapSummary.technicalBlocked }}</strong>
            </div>
            <div class="regression-gap-card">
              <span>待人工复核</span>
              <strong>{{ regressionGapSummary.pendingHumanReview }}</strong>
            </div>
            <div class="regression-gap-card warning">
              <span>人工返工</span>
              <strong>{{ regressionGapSummary.rework }}</strong>
            </div>
            <div class="regression-gap-card warning">
              <span>人工证据缺口</span>
              <strong>{{ qualityRegression.summary.reviewEvidenceGapCount }}</strong>
            </div>
            <div class="regression-gap-card passed">
              <span>人工通过</span>
              <strong>{{ regressionGapSummary.approved }}</strong>
            </div>
          </div>
          <div v-if="regressionEvidenceGapBuckets.length" class="regression-evidence-gaps">
            <div class="platform-evidence-title">
              <strong>人工证据分组</strong>
              <span>{{ qualityRegression.reviewEvidence.totalGapCount }} 项</span>
            </div>
            <div class="regression-sample-filters">
              <button
                v-for="bucket in qualityRegression.reviewEvidence.buckets"
                :key="bucket.code"
                class="sample-filter-chip"
                :class="{
                  active:
                    regressionEvidenceGapFilterByKey[regressionSampleFilter] === bucket.code,
                }"
                type="button"
                :disabled="bucket.count === 0"
                @click="
                  regressionSampleFilter =
                    regressionEvidenceGapFilterKeyByCode[bucket.code] || 'all'
                "
              >
                {{ bucket.label }} {{ bucket.count }}
              </button>
            </div>
          </div>
        </div>
        <details v-if="regressionTagTargets.length" class="regression-tag-disclosure">
          <summary>
            <span>标记回归样本覆盖类型</span>
            <span>Export #{{ regressionTagTargetExportId || '-' }}</span>
          </summary>
          <div class="regression-tag-editor">
          <div class="platform-evidence-title">
            <strong>标记回归样本覆盖类型</strong>
            <span>Export #{{ regressionTagTargetExportId || '-' }}</span>
          </div>
          <p class="history-sub">只保存标签，不启动 Worker 或模型；用于 10 条终剪回归覆盖统计。</p>
          <label class="review-token-field">
            <span>选择回归样本</span>
            <select
              v-model.number="regressionTagTargetExportId"
              class="review-token-input"
              @change="syncRegressionTagForm(regressionTagTargetExportId, true)"
            >
              <option
                v-for="target in regressionTagTargets"
                :key="target.exportId"
                :value="target.exportId"
              >
                Export #{{ target.exportId }} · {{ target.status }} ·
                已标记 {{ target.coverageTags.length }} 类
              </option>
            </select>
          </label>
          <div class="regression-tag-grid">
            <label
              v-for="option in regressionCoverageOptions"
              :key="option.key"
              class="regression-tag-option"
            >
              <input
                v-model="regressionTagDraft"
                type="checkbox"
                :value="option.key"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
          <textarea
            v-model="regressionTagNote"
            class="review-note"
            rows="2"
            placeholder="记录为什么这样标记，例如：单人对白、无角色空镜、动作镜头等"
          ></textarea>
          <label class="review-token-field">
            <span>覆盖标签保存口令</span>
            <input
              v-model="regressionTagConfirmationToken"
              class="review-token-input"
              type="text"
              autocomplete="off"
              placeholder="CONFIRM_FINAL_QUALITY_REGRESSION_TAGS"
            />
          </label>
          <button
            class="primary-btn"
            type="button"
            :disabled="!canSaveRegressionTags || isSavingRegressionTags"
            @click="saveSelectedRegressionTags"
          >
            {{ isSavingRegressionTags ? '保存中...' : '保存覆盖类型' }}
          </button>
          </div>
        </details>
        <div class="regression-workbench-grid">
        <div v-if="regressionSampleRows.length" class="regression-review-workbench">
          <div class="platform-evidence-title">
            <strong>单条样本人工复核</strong>
            <span>Export #{{ regressionReviewTargetExportId || '-' }}</span>
          </div>
          <p class="history-sub">只保存人工复核证据，不启动 Worker 或模型；批准后仍要进入 10 条整体回归统计。</p>
          <div class="regression-review-navigator">
            <div class="platform-evidence-title">
              <strong>待补样本导航</strong>
              <span>只读定位</span>
            </div>
            <div class="coverage-buckets compact">
              <span class="coverage-chip">缺报告 {{ regressionReviewQueueSummary.missingReports }}</span>
              <span class="coverage-chip">技术阻塞 {{ regressionReviewQueueSummary.technicalBlocked }}</span>
              <span class="coverage-chip">证据缺口 {{ regressionReviewQueueSummary.evidenceGaps }}</span>
              <span class="coverage-chip covered">已补齐 {{ regressionReviewQueueSummary.ready }}</span>
            </div>
            <p class="history-sub">只切换当前复核目标，不保存、不启动 Worker 或模型。</p>
            <button
              class="ghost-btn compact-btn"
              type="button"
              @click="focusNextRegressionReviewTarget"
            >
              定位下一条待补样本
            </button>
          </div>
          <label class="review-token-field">
            <span>选择复核样本</span>
            <select
              v-model.number="regressionReviewTargetExportId"
              class="review-token-input"
              @change="syncRegressionReviewForm(regressionReviewTargetExportId, true)"
            >
              <option
                v-for="row in regressionSampleRows"
                :key="row.exportId"
                :value="row.exportId"
              >
                Export #{{ row.exportId }} · {{ row.technicalText }} · {{ row.reviewText }}
              </option>
            </select>
          </label>

          <div v-if="regressionReviewTargetExport" class="regression-review-target">
            <video
              v-if="regressionReviewTargetExport.status === 'completed'"
              :src="getPlaybackUrl(regressionReviewTargetExport)"
              controls
              playsinline
              @ended="regressionReviewPlaybackCompleted = true"
              class="latest-video compact-video"
            ></video>
            <div class="coverage-buckets compact">
              <span
                class="coverage-chip"
                :class="{ covered: regressionReviewTargetSample?.technicalPassed }"
              >
                {{ regressionReviewTargetSample?.technicalPassed ? '技术通过' : '技术阻塞' }}
              </span>
              <span
                class="coverage-chip"
                :class="{ covered: regressionReviewTargetReport?.releaseStatus === 'release-candidate' }"
              >
                {{ regressionReviewTargetReport?.releaseStatus || '缺少质量报告' }}
              </span>
              <span class="coverage-chip">{{ regressionReviewTargetSample?.reviewEvidenceGapText || '证据待同步' }}</span>
            </div>
          </div>
          <p v-else class="message warning">当前样本没有导出记录，只能先查看只读清单，不能提交人工复核。</p>

          <div class="regression-review-todo">
            <div class="platform-evidence-title">
              <strong>当前样本待补项</strong>
              <span>只读清单</span>
            </div>
            <p class="history-sub">只读清单，不保存、不启动 Worker 或模型。</p>
            <ul v-if="regressionReviewTargetTodoItems.length" class="regression-review-todo-list">
              <li
                v-for="item in regressionReviewTargetTodoItems"
                :key="item.key"
                class="regression-review-todo-item"
              >
                <strong>{{ item.label }}</strong>
                <span>{{ item.detail }}</span>
              </li>
            </ul>
            <p v-else class="message success">当前样本已补齐技术报告、人工证据和批准状态。</p>
          </div>

          <details
            v-if="
              regressionReviewEvidenceSummaryItems.length ||
              regressionReviewDraftStatusItems.length ||
              regressionReviewApprovalBlockers.length ||
              regressionReviewSaveScopeItems.length ||
              regressionReviewAuditItems.length ||
              regressionReviewSummaryText
            "
            class="regression-review-records"
            :open="hasRegressionReviewUnsavedDraft"
          >
            <summary>
              <span>查看已保存证据与复核记录</span>
              <span>{{ hasRegressionReviewUnsavedDraft ? '有未保存改动' : '只读记录' }}</span>
            </summary>
          <div v-if="regressionReviewEvidenceSummaryItems.length" class="regression-review-evidence-summary">
            <div class="platform-evidence-title">
              <strong>已留存终审证据</strong>
              <span>报告快照</span>
            </div>
            <p class="history-sub">只读展示已经保存到质量报告的证据，不包含当前尚未保存的输入。</p>
            <ul class="regression-review-evidence-list">
              <li
                v-for="item in regressionReviewEvidenceSummaryItems"
                :key="item.key"
                class="regression-review-evidence-item"
                :class="{ saved: item.saved }"
              >
                <div>
                  <strong>{{ item.label }}</strong>
                  <span>{{ item.status }}</span>
                </div>
                <p>{{ item.note }}</p>
              </li>
            </ul>
          </div>

          <div
            v-if="regressionReviewDraftStatusItems.length"
            class="regression-review-draft-status"
            :class="{ changed: hasRegressionReviewUnsavedDraft }"
          >
            <div class="platform-evidence-title">
              <strong>当前输入保存状态</strong>
              <span>{{ hasRegressionReviewUnsavedDraft ? '有未保存' : '已同步' }}</span>
            </div>
            <p class="history-sub">
              只读对比，不保存、不发布、不启动 Worker 或模型。{{ hasRegressionReviewUnsavedDraft ? '当前输入尚未保存。' : '当前输入与报告快照一致。' }}
            </p>
            <ul class="regression-review-draft-list">
              <li
                v-for="item in regressionReviewDraftStatusItems"
                :key="item.key"
                class="regression-review-draft-item"
                :class="{ changed: item.changed }"
              >
                <strong>{{ item.label }}</strong>
                <span>{{ item.status }}</span>
                <p>{{ item.detail }}</p>
              </li>
            </ul>
          </div>

          <div
            v-if="regressionReviewApprovalBlockers.length"
            class="regression-review-approval-blockers"
          >
            <div class="platform-evidence-title">
              <strong>审批前缺口</strong>
              <span>{{ regressionReviewApprovalBlockers.length }} 项</span>
            </div>
            <p class="history-sub">只读说明，不保存、不启动 Worker 或模型。</p>
            <ul class="regression-review-todo-list">
              <li
                v-for="item in regressionReviewApprovalBlockers"
                :key="item.key"
                class="regression-review-todo-item"
              >
                <strong>{{ item.label }}</strong>
                <span>{{ item.detail }}</span>
              </li>
            </ul>
          </div>

          <div v-if="regressionReviewSaveScopeItems.length" class="regression-review-save-scope">
            <div class="platform-evidence-title">
              <strong>保存影响范围</strong>
              <span>单条样本</span>
            </div>
            <ul class="regression-review-todo-list">
              <li
                v-for="item in regressionReviewSaveScopeItems"
                :key="item.key"
                class="regression-review-scope-item"
              >
                <strong>{{ item.label }}</strong>
                <span>{{ item.detail }}</span>
              </li>
            </ul>
          </div>

          <div v-if="regressionReviewAuditItems.length" class="regression-review-audit">
            <div class="platform-evidence-title">
              <strong>复核历史</strong>
              <span>只读审计</span>
            </div>
            <p class="history-sub">只读审计，不保存、不发布、不启动 Worker 或模型。</p>
            <dl class="regression-review-audit-list">
              <div
                v-for="item in regressionReviewAuditItems"
                :key="item.key"
                class="regression-review-audit-item"
              >
                <dt>{{ item.label }}</dt>
                <dd>
                  <strong>{{ item.value }}</strong>
                  <span>{{ item.detail }}</span>
                </dd>
              </div>
            </dl>
          </div>

          <div v-if="regressionReviewSummaryText" class="regression-review-summary">
            <div class="platform-evidence-title">
              <strong>终审摘要</strong>
              <span>本地操作</span>
            </div>
            <p class="history-sub">
              复制或下载当前样本的只读终审摘要，内容会明确区分已保存证据和未保存草稿。
            </p>
            <div class="regression-review-summary-actions">
              <button
                class="ghost-btn compact-btn"
                type="button"
                @click="copyRegressionReviewSummary"
              >
                复制终审摘要
              </button>
              <button
                class="ghost-btn compact-btn"
                type="button"
                @click="downloadRegressionReviewSummary"
              >
                下载终审摘要
              </button>
              <button
                class="ghost-btn compact-btn"
                type="button"
                @click="printRegressionReviewChecklist"
              >
                打印签核清单
              </button>
            </div>
            <p v-if="regressionReviewSummaryMessage" class="message success" aria-live="polite">
              {{ regressionReviewSummaryMessage }}
            </p>
            <p class="history-sub">只读摘要，不保存、不发布、不启动 Worker 或模型。</p>
          </div>
            </details>

          <section
            v-if="regressionReviewSummaryText"
            class="regression-review-print-sheet"
            aria-label="打印版签核清单"
          >
            <header class="regression-review-print-header">
              <div>
                <p class="regression-review-print-kicker">帧心帧意 · P7 人工终审</p>
                <h1>打印版签核清单</h1>
              </div>
              <span class="regression-review-print-status">
                {{ regressionReviewTargetReport?.releaseStatus || 'blocked' }}
              </span>
            </header>

            <section class="regression-review-print-section">
              <h2>样本信息</h2>
              <dl class="regression-review-print-meta">
                <div>
                  <dt>项目</dt>
                  <dd>#{{ projectId || '-' }}</dd>
                </div>
                <div>
                  <dt>导出</dt>
                  <dd>#{{ regressionReviewTargetExportId }}</dd>
                </div>
                <div>
                  <dt>质量报告</dt>
                  <dd>{{ regressionReviewTargetReport ? `#${regressionReviewTargetReport.id}` : '未生成' }}</dd>
                </div>
                <div>
                  <dt>技术状态</dt>
                  <dd>{{ regressionReviewTargetSample?.technicalText || '暂无样本状态' }}</dd>
                </div>
                <div>
                  <dt>覆盖类型</dt>
                  <dd>{{ regressionReviewTargetSample?.coverageText || '未标记' }}</dd>
                </div>
                <div>
                  <dt>当前输入</dt>
                  <dd>{{ hasRegressionReviewUnsavedDraft ? '存在未保存改动' : '与质量报告一致' }}</dd>
                </div>
              </dl>
            </section>

            <section class="regression-review-print-section">
              <h2>人工终审证据</h2>
              <table class="regression-review-print-table">
                <thead>
                  <tr>
                    <th>检查项</th>
                    <th>已留存状态</th>
                    <th>当前输入状态</th>
                    <th>已保存备注</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in regressionReviewEvidenceSummaryItems"
                    :key="`print-evidence-${item.key}`"
                  >
                    <td>{{ item.label }}</td>
                    <td>{{ item.status }}</td>
                    <td>
                      {{
                        regressionReviewDraftStatusItems.find((draft) => draft.key === item.key)?.status ||
                        '暂无草稿'
                      }}
                    </td>
                    <td>{{ item.note }}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section class="regression-review-print-section">
              <h2>审批状态</h2>
              <dl class="regression-review-print-meta">
                <div>
                  <dt>人工结论</dt>
                  <dd>{{ regressionReviewAuditItems.find((item) => item.key === 'review-decision')?.value || '尚未复核' }}</dd>
                </div>
                <div>
                  <dt>复核时间</dt>
                  <dd>{{ regressionReviewAuditItems.find((item) => item.key === 'reviewed-at')?.value || '暂无记录' }}</dd>
                </div>
                <div>
                  <dt>最后更新</dt>
                  <dd>{{ regressionReviewAuditItems.find((item) => item.key === 'updated-at')?.value || '暂无记录' }}</dd>
                </div>
                <div>
                  <dt>内部发布状态</dt>
                  <dd>{{ regressionReviewTargetReport?.releaseStatus || 'blocked' }}</dd>
                </div>
              </dl>
              <ul v-if="regressionReviewApprovalBlockers.length" class="regression-review-print-list">
                <li v-for="item in regressionReviewApprovalBlockers" :key="`print-blocker-${item.key}`">
                  <strong>{{ item.label }}</strong>
                  <span>{{ item.detail }}</span>
                </li>
              </ul>
              <p v-else class="regression-review-print-ok">当前表单没有审批前缺口。</p>
            </section>

            <section class="regression-review-print-signature">
              <div>
                <span>签核人</span>
                <strong>____________________________</strong>
              </div>
              <div>
                <span>签核日期</span>
                <strong>____________________________</strong>
              </div>
            </section>

            <footer class="regression-review-print-footer">
              <p>打印操作不保存、不发布、不启动 Worker 或模型。</p>
              <p>内部发布状态不代表平台审核通过或稳定盈利。</p>
            </footer>
          </section>

          <div v-if="!regressionReviewTargetReport" class="regression-report-action">
            <p class="message warning">
              该样本缺少技术质量报告，请先为对应 Export 生成报告，再进行人工复核。
            </p>
            <p class="history-sub">只检查这一条已完成导出，不启动 Worker 或模型。</p>
            <button
              class="ghost-btn"
              type="button"
              :disabled="!canCreateRegressionSampleReport"
              @click="createRegressionSampleQualityReport"
            >
              {{ isCreatingRegressionSampleReport ? '生成中...' : '为选中样本生成技术质量报告' }}
            </button>
          </div>
          <div
            v-else-if="!regressionReviewTargetReport.automaticPassed"
            class="quality-review-body"
          >
            <p
              v-for="issue in regressionReviewTargetReport.automaticReport.blockingIssues || []"
              :key="issue.code"
              class="message error"
            >
              {{ issue.message }}
            </p>
            <button
              class="ghost-btn"
              type="button"
              :disabled="!canSaveRegressionSampleRework"
              @click="saveRegressionSampleReview('rework')"
            >
              标记该样本返工
            </button>
          </div>
          <div v-else class="review-checklist">
            <label>
              <input v-model="regressionReviewChecks.visualReviewed" type="checkbox" />
              <span>画面与人物表现已复核</span>
            </label>
            <textarea
              v-model="regressionReviewEvidenceNotes.visual"
              class="review-note compact"
              placeholder="记录画面是否拉伸、黑边、跳帧、主体裁切"
            ></textarea>
            <label>
              <input v-model="regressionReviewChecks.subtitleReviewed" type="checkbox" />
              <span>字幕文本与安全区已复核</span>
            </label>
            <textarea
              v-model="regressionReviewEvidenceNotes.subtitle"
              class="review-note compact"
              placeholder="记录字幕准确性、错别字和安全区"
            ></textarea>
            <label>
              <input v-model="regressionReviewChecks.audioReviewed" type="checkbox" />
              <span>对白、BGM 与音效已复核</span>
            </label>
            <textarea
              v-model="regressionReviewEvidenceNotes.audio"
              class="review-note compact"
              placeholder="记录对白清晰度、响度、爆音和对嘴"
            ></textarea>
            <p class="history-sub audio-review-hint">完整播放到结尾后才能勾选听感确认。</p>
            <div class="review-subchecks">
              <label>
                <input
                  v-model="regressionReviewAudioEvidence.listeningConfirmed"
                  type="checkbox"
                  :disabled="
                    !regressionReviewPlaybackCompleted &&
                    !regressionReviewAudioEvidence.listeningConfirmed
                  "
                />
                <span>实际完整播放过成片</span>
              </label>
              <label>
                <input v-model="regressionReviewAudioEvidence.clarityReviewed" type="checkbox" />
                <span>对白清晰，无明显底噪</span>
              </label>
              <label>
                <input v-model="regressionReviewAudioEvidence.loudnessReviewed" type="checkbox" />
                <span>响度与 BGM/SFX 平衡</span>
              </label>
              <label>
                <input v-model="regressionReviewAudioEvidence.clippingReviewed" type="checkbox" />
                <span>没有爆音或明显失真</span>
              </label>
              <label>
                <input
                  v-model="regressionReviewAudioEvidence.syncReviewed"
                  type="checkbox"
                  @change="toggleRegressionSyncReviewed"
                />
                <span>对白与画面同步</span>
              </label>
              <label>
                <input
                  v-model="regressionReviewAudioEvidence.syncNotApplicable"
                  type="checkbox"
                  @change="toggleRegressionSyncNotApplicable"
                />
                <span>对白同步不适用（无可见说话人物）</span>
              </label>
            </div>
            <label>
              <input v-model="regressionReviewChecks.characterConsistencyReviewed" type="checkbox" />
              <span>人物一致性已复核</span>
            </label>
            <label>
              <input
                v-model="regressionReviewChecks.characterConsistencyNotApplicable"
                type="checkbox"
              />
              <span>人物一致性不适用（无实体人物）</span>
            </label>
            <textarea
              v-model="regressionReviewEvidenceNotes.characterConsistency"
              class="review-note compact"
              placeholder="记录人物外貌、发型、服装、体型和同屏角色数量"
            ></textarea>
            <textarea
              v-model="regressionReviewNote"
              class="review-note"
              placeholder="填写该样本的复核结论或返工原因"
            ></textarea>
            <label class="review-token-field">
              <span>批准确认口令</span>
              <input
                v-model="regressionReviewConfirmationToken"
                class="review-token-input"
                type="text"
                autocomplete="off"
                placeholder="APPROVE_FINAL_QUALITY_REVIEW"
              />
            </label>
            <div class="review-actions">
              <button
                class="ghost-btn"
                type="button"
                :disabled="!canSaveRegressionSampleRework"
                @click="saveRegressionSampleReview('rework')"
              >
                标记返工
              </button>
              <button
                class="primary-btn"
                type="button"
                :disabled="!canApproveRegressionSampleReview || isSavingRegressionSampleReview"
                @click="saveRegressionSampleReview('approved')"
              >
                {{ isSavingRegressionSampleReview ? '保存中...' : '批准该样本' }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="regressionSampleRows.length" class="regression-sample-list">
          <div class="platform-evidence-title">
            <strong>样本复核清单</strong>
            <span>{{ filteredRegressionSampleRows.length }} / {{ regressionSampleRows.length }} 条</span>
          </div>
          <div class="regression-sample-filters" aria-label="筛选样本">
            <button
              v-for="option in regressionSampleFilterOptions"
              :key="option.key"
              class="sample-filter-chip"
              :class="{ active: regressionSampleFilter === option.key }"
              type="button"
              @click="regressionSampleFilter = option.key"
            >
              {{ option.label }} {{ option.count }}
            </button>
          </div>
          <article
            v-for="row in filteredRegressionSampleRows"
            :key="row.exportId"
            class="regression-sample-row"
            :class="{
              active:
                row.exportId === regressionTagTargetExportId ||
                row.exportId === regressionReviewTargetExportId,
            }"
          >
            <div>
              <div class="regression-sample-title">
                <strong>Export #{{ row.exportId }}</strong>
                <span>{{ row.status }}</span>
              </div>
              <div class="coverage-buckets compact">
                <span
                  class="coverage-chip"
                  :class="{ covered: row.technicalPassed }"
                >
                  {{ row.technicalText }}
                </span>
                <span
                  class="coverage-chip"
                  :class="{ covered: row.reviewDecision === 'approved' }"
                >
                  {{ row.reviewText }}
                </span>
                <span class="coverage-chip">{{ row.releaseText }}</span>
              </div>
              <p class="history-sub">覆盖标签：{{ row.coverageText }}</p>
              <p v-if="row.qualityGapCodes.length" class="history-sub">
                待补缺口：{{ row.gapText }}
              </p>
              <p v-if="row.reviewEvidenceGaps.length" class="history-sub">
                人工证据缺口：{{ row.reviewEvidenceGapText }}
              </p>
              <p class="history-sub action-hint">
                下一步：{{ row.nextActionText }}。{{ row.nextActionMessage }}
              </p>
            </div>
            <div class="regression-sample-actions">
              <button
                class="ghost-btn compact-btn"
                type="button"
                @click="syncRegressionReviewForm(row.exportId, true)"
              >
                复核此样本
              </button>
              <button
                class="ghost-btn compact-btn"
                type="button"
                @click="syncRegressionTagForm(row.exportId, true)"
              >
                标记此样本
              </button>
            </div>
          </article>
          <p v-if="!filteredRegressionSampleRows.length" class="history-sub">
            当前筛选下暂无样本。
          </p>
        </div>
        </div>
        <div v-if="qualityRegression.reworkReasons.length" class="regression-reasons">
          <p
            v-for="reason in qualityRegression.reworkReasons.slice(0, 3)"
            :key="`${reason.exportId}-${reason.code}`"
            class="history-sub"
          >
            Export #{{ reason.exportId }} · {{ reason.message }}
          </p>
        </div>
      </section>

      <div class="main-grid evidence-grid">
        <section id="cost-ledger-gate" class="panel cost-ledger-panel">
          <div class="panel-head">
            <div>
              <h2>成本台账</h2>
              <p class="panel-sub">只展示已记录的生产证据；未配置价格的模型不会被虚构计价。</p>
            </div>
            <span class="panel-tag">{{ costLedger?.summary.entryCount || 0 }} 条</span>
          </div>
          <div class="summary-grid compact cost-ledger-summary">
            <div class="summary-card cost-ledger-metric cost-ledger-metric-total">
              <span class="summary-label">已估算成本</span>
              <strong
                class="summary-value cost-ledger-value"
                :class="{ 'is-empty': !costLedgerHasPricing }"
              >
                {{ complianceTotalText }}
              </strong>
              <span class="cost-ledger-metric-foot">
                {{ costLedgerHasPricing ? '按已配置价格目录估算' : '价格目录待配置' }}
              </span>
            </div>
            <div class="summary-card cost-ledger-metric">
              <span class="summary-label">已计价记录</span>
              <strong class="summary-value">{{ costLedger?.summary.pricedEntryCount || 0 }}</strong>
              <span class="cost-ledger-metric-foot">已匹配计价项</span>
            </div>
            <div class="summary-card cost-ledger-metric cost-ledger-metric-unpriced">
              <span class="summary-label">未计价记录</span>
              <strong class="summary-value">{{ costLedger?.summary.unpricedEntryCount || 0 }}</strong>
              <span class="cost-ledger-metric-foot">等待价格配置</span>
            </div>
          </div>
          <div class="cost-ledger-meta">
            <p v-if="qualityRegression" class="history-sub regression-scope-note">
              <span class="cost-ledger-meta-label">样本口径</span>
              <span>
                {{ qualityRegression.sampleScope.includedStatuses.join(' / ') }} ·
                已排除 {{ qualityRegression.sampleScope.excludedCount }} 条非实际终剪尝试记录
              </span>
            </p>
            <p v-if="costLedger && !costLedger.pricingCatalogConfigured" class="history-sub">
              <span class="cost-ledger-meta-label">计价状态</span>
              <span>未配置 COST_PRICING_CATALOG，保留数量与模型证据，不推算真实费用。</span>
            </p>
          </div>
        </section>

        <section
          v-if="releaseCompliance"
          id="release-compliance-gate"
          class="panel release-compliance-panel"
        >
          <div class="panel-head">
            <div>
              <h2>发布合规包</h2>
              <p class="panel-sub">这是内部发布候选检查，不代表红果或抖音平台审核结论。</p>
            </div>
            <span
              class="status-chip"
              :class="releaseCompliance.canPublish ? 'ready' : 'missing'"
            >
              {{ releaseCompliance.status }}
            </span>
          </div>

          <div v-if="releaseCompliance.blockingIssues.length" class="quality-issues">
            <p
              v-for="item in releaseCompliance.blockingIssues"
              :key="item.code"
              class="message error"
            >
              {{ item.message }}
            </p>
          </div>
          <p
            v-for="warning in releaseCompliance.warnings"
            :key="warning.code"
            class="message warning"
          >
            {{ warning.message }}
          </p>
          <p v-if="releaseCompliance.audit?.evidenceHash" class="history-sub audit-fingerprint">
            合规证据指纹：{{ releaseCompliance.audit?.evidenceHash.slice(0, 16) }}
          </p>
          <div
            v-if="releaseCompliance.releaseCandidateSnapshot"
            class="candidate-snapshot"
          >
            <strong>发布候选快照</strong>
            <p class="history-sub">
              Export #{{ releaseCompliance.releaseCandidateSnapshot.exportId }} ·
              {{ releaseCompliance.releaseCandidateSnapshot.technicalSpec.resolution || '-' }} ·
              {{ releaseCompliance.releaseCandidateSnapshot.technicalSpec.frameRate || '-' }} fps
            </p>
            <p class="history-sub">
              目标平台：{{
                releaseCompliance.releaseCandidateSnapshot.platforms
                  .map((platform) => platformLabel(platform))
                  .join(' / ') || '未设置'
              }}
            </p>
            <p class="history-sub">
              快照证据指纹：{{
                releaseCompliance.releaseCandidateSnapshot.evidenceHash.slice(0, 16)
              }}
            </p>
            <div
              v-if="releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist"
              class="candidate-audio-evidence"
            >
              <strong>音频听感证据</strong>
              <span>
                完整播放：{{
                  releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist
                    .listeningConfirmed
                    ? '已确认'
                    : '缺失'
                }}
              </span>
              <span>
                清晰度：{{
                  releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist
                    .clarityReviewed
                    ? '已确认'
                    : '缺失'
                }}
              </span>
              <span>
                响度平衡：{{
                  releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist
                    .loudnessReviewed
                    ? '已确认'
                    : '缺失'
                }}
              </span>
              <span>
                失真：{{
                  releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist
                    .clippingReviewed
                    ? '已确认'
                    : '缺失'
                }}
              </span>
              <span>
                对白同步：{{
                  releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist
                    .syncReviewed
                    ? '已确认'
                    : releaseCompliance.releaseCandidateSnapshot.humanReviewEvidence.audioChecklist
                          .syncNotApplicable
                      ? '不适用'
                      : '缺失'
                }}
              </span>
            </div>
          </div>

          <div class="compliance-review-section">
            <div class="compliance-section-heading">发布标识确认</div>
            <div class="review-checklist">
              <label>
                <input v-model="complianceConfirmed" type="checkbox" />
                <span>已确认按发布当天的平台规则填写 AI 生成标识</span>
              </label>
              <input
                v-model="complianceLabel"
                class="review-note compliance-label-input"
                type="text"
                placeholder="AI 生成标识展示文案"
              />
            </div>
          </div>
          <div
            v-if="releaseCompliance.platforms.length"
            class="platform-evidence-list compliance-platforms"
          >
            <div class="compliance-section-heading">平台逐项核验</div>
            <div
              v-for="platform in releaseCompliance.platforms"
              :key="platform"
              class="platform-evidence-row"
            >
              <template v-if="platformComplianceEvidence[platform]">
                <div class="platform-evidence-title">
                  <strong>{{ platformLabel(platform) }}</strong>
                  <span>{{ platform }}</span>
                </div>
                <div class="review-checklist compact-stack">
                  <label>
                    <input
                      v-model="platformComplianceEvidence[platform].aiLabelReviewed"
                      type="checkbox"
                    />
                    <span>AI 标识已核验</span>
                  </label>
                  <label>
                    <input
                      v-model="platformComplianceEvidence[platform].copyrightFieldsReviewed"
                      type="checkbox"
                    />
                    <span>版权/投稿字段已核验</span>
                  </label>
                </div>
                <textarea
                  v-model="platformComplianceEvidence[platform].ruleReviewNote"
                  class="review-note"
                  rows="2"
                  placeholder="记录该平台发布页的 AI 标识、版权字段和规则核验依据"
                ></textarea>
              </template>
            </div>
          </div>
          <div class="compliance-save-section">
            <label class="review-token-field compliance-token-field">
              <span>发布合规确认口令</span>
              <input
                v-model="complianceConfirmationToken"
                class="review-token-input"
                type="text"
                autocomplete="off"
                placeholder="CONFIRM_RELEASE_COMPLIANCE_REVIEW"
              />
            </label>
            <button
              class="primary-btn"
              type="button"
              :disabled="!canSaveCompliance || isSavingCompliance"
              @click="saveCompliance"
            >
              {{ isSavingCompliance ? '保存中...' : '保存发布合规信息' }}
            </button>
          </div>
        </section>

        <section v-if="productionReadiness" id="platform-validation-gate" class="panel">
          <div class="panel-head">
            <div>
              <h2>平台与收入证据</h2>
              <p class="panel-sub">只读展示真实发布、平台数据和收入证据缺口；不能用预测替代。</p>
            </div>
            <span
              class="status-chip"
              :class="productionReadiness.stages.platformValidation.passed ? 'ready' : 'missing'"
            >
              {{ productionReadiness.stages.platformValidation.status }}
            </span>
          </div>
          <div class="production-stage-detail-list">
            <p
              v-for="blocker in productionReadiness.stages.platformValidation.blockers"
              :key="blocker.code"
              class="message warning"
            >
              {{ blocker.message }}
            </p>
            <p
              v-if="!productionReadiness.stages.platformValidation.blockers.length"
              class="message success"
            >
              平台发布、平台指标和收入证据已齐；仍需按发布当天平台规则复核。
            </p>
          </div>
          <p class="history-sub">
            该区域只展示证据缺口；平台后台截图、播放/完播/转化和收入结算数据必须来自真实平台。
          </p>
        </section>
      </div>

      <div class="list-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>已就绪分镜</h2>
              <p class="panel-sub">这些分镜已经确认最终视频，会进入本次导出包。</p>
            </div>
            <span class="panel-tag">{{ readyItems.length }} 条</span>
          </div>

          <div v-if="readyItems.length === 0" class="shot-empty">还没有可导出的分镜。</div>

          <div v-else class="shot-list">
            <article v-for="item in readyItems" :key="item.storyboardId" class="shot-item">
              <img v-if="item.imageUrl" :src="item.imageUrl" alt="shot cover" class="shot-cover" />
              <div v-else class="shot-cover placeholder">NO COVER</div>
              <div class="shot-main">
                <div class="shot-title-row">
                  <strong>场景 {{ item.sceneNo }} · {{ resolveShotLabel(item) }}</strong>
                  <span :class="statusClass(item.exportStatus)">{{ item.exportStatus === 'static-ready' ? '可用静帧' : statusLabel(item.exportStatus) }}</span>
                </div>
                <p class="shot-sub">{{ item.sceneTitle || '未命名场景' }}</p>
                <p class="shot-sub">{{ item.shotType || '未填写景别' }} · {{ formatDuration(item.durationSeconds) }}</p>
              </div>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>待补完分镜</h2>
              <p class="panel-sub">这些分镜还没有确认最终视频，暂时不会进入导出包。</p>
            </div>
            <span class="panel-tag">{{ missingItems.length }} 条</span>
          </div>

          <div v-if="missingItems.length === 0" class="shot-empty">当前没有缺失项。</div>

          <div v-else class="shot-list">
            <article v-for="item in missingItems" :key="item.storyboardId" class="shot-item">
              <img v-if="item.imageUrl" :src="item.imageUrl" alt="shot cover" class="shot-cover" />
              <div v-else class="shot-cover placeholder">PENDING</div>
              <div class="shot-main">
                <div class="shot-title-row">
                  <strong>场景 {{ item.sceneNo }} · {{ resolveShotLabel(item) }}</strong>
                  <span :class="statusClass(item.exportStatus)">{{ statusLabel(item.exportStatus) }}</span>
                </div>
                <p class="shot-sub">{{ item.sceneTitle || '未命名场景' }}</p>
                <p class="shot-sub">{{ item.shotType || '未填写景别' }} · {{ formatDuration(item.durationSeconds) }}</p>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.export-page {
  min-height: 100vh;
  background:
    radial-gradient(circle at top right, rgba(217, 119, 6, 0.16), transparent 24%),
    linear-gradient(180deg, #111210 0%, #090909 100%);
  color: #f4ede5;
  padding: 24px;
}

.page-top,
.summary-grid,
.main-grid,
.list-grid,
.field-grid,
.shot-title-row,
.history-title,
.latest-meta,
.top-actions {
  display: flex;
}

.page-top,
.shot-title-row,
.history-title,
.latest-meta,
.top-actions {
  align-items: center;
}

.page-top {
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.eyebrow {
  color: #f0b56f;
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.page-title {
  font-size: 32px;
  font-weight: 800;
  margin: 0;
}

.page-subtitle,
.panel-sub,
.summary-help,
.shot-sub,
.history-sub,
.export-action-sub,
.state-desc,
.history-empty,
.shot-empty {
  color: #c7b39a;
}

.page-subtitle {
  margin-top: 8px;
  font-size: 14px;
  line-height: 1.7;
  max-width: 760px;
}

.top-actions {
  gap: 12px;
  flex-wrap: wrap;
}

.summary-grid {
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.scene-gap-panel {
  margin-bottom: 20px;
}

.regression-panel {
  margin-bottom: 20px;
}

.scene-gap-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.scene-gap-item {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 7px 11px;
  border: 1px solid rgba(248, 113, 113, 0.24);
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.16);
  color: #fecaca;
  font-size: 13px;
}

.summary-card,
.panel,
.state-card,
.message,
.empty-box {
  border: 1px solid rgba(201, 163, 113, 0.18);
  background: rgba(17, 18, 16, 0.84);
  backdrop-filter: blur(10px);
}

.summary-card {
  flex: 1 1 220px;
  padding: 18px;
  border-radius: 18px;
}

.summary-card.highlight {
  border-color: rgba(240, 181, 111, 0.45);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
}

.summary-label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #f0b56f;
  margin-bottom: 12px;
}

.summary-value {
  display: block;
  font-size: 28px;
  margin-bottom: 8px;
}

.summary-help {
  margin: 0;
  line-height: 1.6;
  font-size: 13px;
}

.main-grid,
.list-grid {
  gap: 20px;
}

.main-grid {
  margin-bottom: 20px;
  align-items: start;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
}

.list-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  border-radius: 22px;
  padding: 20px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 18px;
}

.panel-head h2,
.latest-export-head h3,
.empty-box h3,
.state-title {
  margin: 0;
}

.panel-sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
}

.panel-tag,
.status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.panel-tag {
  background: rgba(240, 181, 111, 0.12);
  color: #f0b56f;
  border: 1px solid rgba(240, 181, 111, 0.24);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field span {
  font-size: 12px;
  color: #cfb390;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.field-input {
  min-height: 46px;
  border-radius: 14px;
  border: 1px solid rgba(201, 163, 113, 0.22);
  background: rgba(9, 10, 8, 0.78);
  color: #f4ede5;
  padding: 0 14px;
  outline: none;
}

.field-input:focus {
  border-color: rgba(240, 181, 111, 0.8);
  box-shadow: 0 0 0 2px rgba(240, 181, 111, 0.12);
}

.static-value {
  display: flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
}

.field-toggle {
  justify-content: flex-end;
}

.toggle-btn {
  width: 58px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid rgba(201, 163, 113, 0.2);
  background: rgba(78, 59, 37, 0.35);
  position: relative;
  transition: all 0.2s ease;
}

.toggle-btn.active {
  background: rgba(240, 181, 111, 0.22);
  border-color: rgba(240, 181, 111, 0.45);
}

.toggle-dot {
  position: absolute;
  top: 4px;
  left: 5px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #f4ede5;
  transition: transform 0.2s ease;
}

.toggle-btn.active .toggle-dot {
  transform: translateX(24px);
}

.export-action,
.latest-export,
.empty-box,
.state-card {
  display: flex;
  flex-direction: column;
}

.export-action {
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(240, 181, 111, 0.1), rgba(17, 18, 16, 0.4));
  border: 1px solid rgba(240, 181, 111, 0.2);
}

.export-action-title {
  display: block;
  font-size: 18px;
  margin-bottom: 6px;
}

.export-action-sub {
  margin: 0;
  font-size: 13px;
}

.wide {
  width: 100%;
}

.latest-export {
  margin-top: 18px;
  gap: 12px;
}

.latest-export-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.latest-video {
  width: 100%;
  border-radius: 18px;
  border: 1px solid rgba(201, 163, 113, 0.18);
  background: #080808;
}

.latest-meta {
  gap: 10px;
  flex-wrap: wrap;
  color: #cfb390;
  font-size: 12px;
}

.quality-review {
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid rgba(201, 163, 113, 0.18);
}

.quality-review-head,
.review-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.quality-review-head h3,
.quality-review-head p {
  margin: 0;
}

.quality-review-head p {
  margin-top: 5px;
  color: #c7b39a;
  font-size: 13px;
  line-height: 1.5;
}

.quality-review-body {
  margin-top: 14px;
}

.quality-review-body .message {
  margin-bottom: 10px;
}

.review-checklist {
  display: grid;
  gap: 10px;
}

.review-checklist label {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #e9dccd;
  font-size: 13px;
}

.review-checklist input {
  width: 16px;
  height: 16px;
  accent-color: #f0b56f;
}

.review-subchecks {
  display: grid;
  gap: 8px;
  margin: -2px 0 4px 25px;
  padding-left: 12px;
  border-left: 1px solid rgba(201, 163, 113, 0.22);
}

.review-subchecks label {
  font-size: 12px;
  color: #c7b39a;
}

.review-note {
  width: 100%;
  min-height: 82px;
  resize: vertical;
  border: 1px solid rgba(201, 163, 113, 0.22);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.78);
  color: #f4ede5;
  padding: 10px 12px;
  font: inherit;
  outline: none;
}

.review-note:focus {
  border-color: rgba(240, 181, 111, 0.8);
  box-shadow: 0 0 0 2px rgba(240, 181, 111, 0.12);
}

.review-note.compact {
  min-height: 58px;
}

.review-checklist.compact-stack {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.platform-evidence-list {
  display: grid;
  gap: 12px;
  margin: 14px 0;
}

.candidate-snapshot {
  display: grid;
  gap: 6px;
  margin: 14px 0;
  padding: 12px;
  border: 1px solid rgba(87, 205, 145, 0.22);
  border-radius: 8px;
  background: rgba(87, 205, 145, 0.08);
}

.candidate-snapshot strong {
  color: #8fe3b0;
  font-size: 13px;
}

.candidate-audio-evidence {
  display: grid;
  gap: 5px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(87, 205, 145, 0.18);
  color: #c7b39a;
  font-size: 12px;
}

.candidate-audio-evidence strong {
  color: #e9dccd;
  font-size: 13px;
}

.regression-reasons {
  display: grid;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid rgba(201, 163, 113, 0.14);
}

.coverage-buckets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.coverage-buckets.compact {
  margin: 8px 0;
}

.coverage-chip {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 154, 139, 0.22);
  background: rgba(127, 29, 29, 0.14);
  color: #ffb0a3;
  font-size: 12px;
}

.coverage-chip.covered {
  border-color: rgba(87, 205, 145, 0.22);
  background: rgba(87, 205, 145, 0.08);
  color: #8fe3b0;
}

.regression-tag-editor {
  display: grid;
  gap: 12px;
  margin: 14px 0;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.36);
}

.regression-tag-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
}

.regression-tag-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: #f4ede5;
  font-size: 13px;
}

.regression-review-workbench {
  display: grid;
  gap: 12px;
  margin: 14px 0;
  padding: 12px;
  border: 1px solid rgba(240, 181, 111, 0.22);
  border-radius: 8px;
  background: rgba(240, 181, 111, 0.055);
}

.regression-review-target {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.regression-review-navigator {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.26);
}

.regression-review-navigator .ghost-btn {
  justify-self: start;
}

.regression-review-todo {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.3);
}

.regression-review-todo .message {
  margin: 0;
}

.regression-review-evidence-summary,
.regression-review-draft-status,
.regression-review-approval-blockers {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.3);
}

.regression-review-draft-status.changed {
  border-color: rgba(240, 181, 111, 0.24);
  background: rgba(240, 181, 111, 0.075);
}

.regression-review-approval-blockers {
  border-color: rgba(255, 154, 139, 0.2);
  background: rgba(127, 29, 29, 0.08);
}

.regression-review-save-scope {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(87, 205, 145, 0.18);
  border-radius: 8px;
  background: rgba(87, 205, 145, 0.055);
}

.regression-review-summary {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(240, 181, 111, 0.2);
  border-radius: 8px;
  background: rgba(240, 181, 111, 0.055);
}

.regression-review-summary-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.regression-review-print-sheet {
  display: none;
}

.regression-review-print-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 18px;
  border-bottom: 2px solid #1f2933;
}

.regression-review-print-kicker {
  margin: 0 0 6px;
  color: #52606d;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.regression-review-print-header h1 {
  margin: 0;
  color: #111827;
  font-size: 24px;
}

.regression-review-print-status {
  padding: 6px 10px;
  border: 1px solid #9ca3af;
  color: #374151;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.regression-review-print-section {
  display: grid;
  gap: 10px;
  margin-top: 18px;
}

.regression-review-print-section h2 {
  margin: 0;
  color: #111827;
  font-size: 15px;
}

.regression-review-print-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 18px;
  margin: 0;
}

.regression-review-print-meta div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid #d1d5db;
}

.regression-review-print-meta dt {
  color: #4b5563;
  font-size: 12px;
}

.regression-review-print-meta dd {
  margin: 0;
  color: #111827;
  font-size: 12px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.regression-review-print-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.regression-review-print-table th,
.regression-review-print-table td {
  padding: 8px;
  border: 1px solid #9ca3af;
  color: #111827;
  font-size: 11px;
  line-height: 1.45;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.regression-review-print-table th {
  background: #f3f4f6;
  font-weight: 700;
}

.regression-review-print-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.regression-review-print-list li {
  display: grid;
  gap: 3px;
  padding: 7px 8px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
}

.regression-review-print-list strong,
.regression-review-print-list span {
  color: #111827;
  font-size: 11px;
  line-height: 1.45;
}

.regression-review-print-ok {
  margin: 0;
  color: #166534;
  font-size: 12px;
  font-weight: 600;
}

.regression-review-print-signature {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  margin-top: 34px;
}

.regression-review-print-signature div {
  display: grid;
  gap: 12px;
  color: #374151;
  font-size: 12px;
}

.regression-review-print-signature strong {
  color: #111827;
  font-weight: 400;
  letter-spacing: 0.05em;
}

.regression-review-print-footer {
  display: grid;
  gap: 3px;
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid #9ca3af;
}

.regression-review-print-footer p {
  margin: 0;
  color: #4b5563;
  font-size: 10px;
  line-height: 1.45;
}

.regression-review-audit {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.3);
}

.regression-review-evidence-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.regression-review-draft-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.regression-review-draft-item {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid rgba(87, 205, 145, 0.2);
  border-radius: 8px;
  background: rgba(87, 205, 145, 0.07);
}

.regression-review-draft-item.changed {
  border-color: rgba(240, 181, 111, 0.28);
  background: rgba(120, 75, 20, 0.16);
}

.regression-review-draft-item strong {
  color: #f4ede5;
  font-size: 13px;
}

.regression-review-draft-item span {
  color: #8fe3b0;
  font-size: 12px;
}

.regression-review-draft-item.changed span {
  color: #f0b56f;
}

.regression-review-draft-item p {
  margin: 0;
  color: #d8c7b9;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.regression-review-evidence-item {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid rgba(255, 154, 139, 0.18);
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.1);
}

.regression-review-evidence-item.saved {
  border-color: rgba(87, 205, 145, 0.22);
  background: rgba(87, 205, 145, 0.08);
}

.regression-review-evidence-item > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.regression-review-evidence-item strong {
  color: #f4ede5;
  font-size: 13px;
}

.regression-review-evidence-item span {
  color: #ffbdad;
  font-size: 12px;
}

.regression-review-evidence-item.saved span {
  color: #8fe3b0;
}

.regression-review-evidence-item p {
  margin: 0;
  color: #d8c7b9;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.regression-review-todo-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.regression-review-todo-item {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid rgba(255, 154, 139, 0.18);
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.12);
}

.regression-review-todo-item strong {
  color: #ffbdad;
  font-size: 13px;
}

.regression-review-todo-item span {
  color: #d8c7b9;
  font-size: 12px;
  line-height: 1.55;
}

.regression-review-scope-item {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid rgba(87, 205, 145, 0.18);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.22);
}

.regression-review-scope-item strong {
  color: #b6f0c9;
  font-size: 13px;
}

.regression-review-scope-item span {
  color: #d8c7b9;
  font-size: 12px;
  line-height: 1.55;
}

.regression-review-audit-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 8px;
  margin: 0;
}

.regression-review-audit-item {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid rgba(201, 163, 113, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.regression-review-audit-item dt {
  color: #c7b39a;
  font-size: 12px;
}

.regression-review-audit-item dd {
  display: grid;
  gap: 4px;
  margin: 0;
}

.regression-review-audit-item strong {
  color: #f4ede5;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.regression-review-audit-item span {
  color: #d8c7b9;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.regression-report-action {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid rgba(240, 181, 111, 0.18);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.32);
}

.regression-report-action .message {
  margin: 0;
}

.regression-report-action .ghost-btn {
  justify-self: start;
}

.compact-video {
  max-height: 360px;
  object-fit: contain;
}

.regression-gap-summary {
  display: grid;
  gap: 10px;
  margin: 14px 0;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.production-readiness-card {
  display: grid;
  gap: 8px;
  margin: 14px 0;
  padding: 12px;
  border: 1px solid rgba(240, 181, 111, 0.2);
  border-radius: 8px;
  background: rgba(240, 181, 111, 0.06);
}

.production-readiness-blocker {
  color: #ffb0a3;
}

.regression-gap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}

.regression-gap-card {
  display: grid;
  gap: 4px;
  min-height: 62px;
  padding: 10px;
  border: 1px solid rgba(201, 163, 113, 0.14);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.34);
}

.regression-gap-card span {
  color: #c7b39a;
  font-size: 12px;
}

.regression-gap-card strong {
  color: #f4ede5;
  font-size: 20px;
  line-height: 1;
}

.regression-gap-card.warning {
  border-color: rgba(255, 154, 139, 0.22);
  background: rgba(127, 29, 29, 0.12);
}

.regression-gap-card.warning strong {
  color: #ffb0a3;
}

.regression-gap-card.passed {
  border-color: rgba(87, 205, 145, 0.22);
  background: rgba(87, 205, 145, 0.08);
}

.regression-gap-card.passed strong {
  color: #8fe3b0;
}

.regression-evidence-gaps {
  display: grid;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(201, 163, 113, 0.14);
}

.regression-sample-list {
  display: grid;
  gap: 10px;
  margin: 14px 0;
}

.regression-sample-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sample-filter-chip {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(201, 163, 113, 0.18);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.34);
  color: #c7b39a;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sample-filter-chip:hover,
.sample-filter-chip.active {
  border-color: rgba(240, 181, 111, 0.46);
  background: rgba(240, 181, 111, 0.1);
  color: #f4ede5;
}

.regression-sample-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 12px;
  border: 1px solid rgba(201, 163, 113, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.regression-sample-row.active {
  border-color: rgba(240, 181, 111, 0.48);
  background: rgba(240, 181, 111, 0.08);
}

.regression-sample-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.regression-sample-title {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  color: #f4ede5;
  font-size: 13px;
}

.regression-sample-title span {
  color: #c7b39a;
  font-size: 12px;
}

.compact-btn {
  min-height: 34px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12px;
}

.platform-evidence-row {
  display: grid;
  gap: 10px;
  padding: 12px 0;
  border-top: 1px solid rgba(201, 163, 113, 0.14);
}

.platform-evidence-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #f4ede5;
  font-size: 13px;
}

.platform-evidence-title span {
  color: #c7b39a;
  font-size: 12px;
}

.compliance-token-field {
  margin: 14px 0;
}

.review-token-field {
  display: grid;
  gap: 7px;
  color: #e9dccd;
  font-size: 13px;
}

.review-token-input {
  width: 100%;
  min-height: 42px;
  border: 1px solid rgba(201, 163, 113, 0.22);
  border-radius: 8px;
  background: rgba(9, 10, 8, 0.78);
  color: #f4ede5;
  padding: 0 12px;
  font: inherit;
  outline: none;
}

.review-token-input:focus {
  border-color: rgba(240, 181, 111, 0.8);
  box-shadow: 0 0 0 2px rgba(240, 181, 111, 0.12);
}

.review-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.history-list,
.shot-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-item,
.shot-item {
  display: flex;
  gap: 14px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  background: rgba(10, 10, 10, 0.62);
}

.history-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  min-width: 0;
}

.history-main {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.history-title {
  align-items: center;
  margin: 0;
}

.history-identity {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.history-type {
  color: #8d8174;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.history-identity strong {
  color: #f4ede5;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.history-sub {
  margin: 6px 0 0;
  font-size: 12px;
}

.history-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  color: #c7b39a;
  font-size: 12px;
  line-height: 1.4;
}

.history-meta span {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding-right: 10px;
  margin-right: 10px;
  border-right: 1px solid rgba(201, 163, 113, 0.2);
}

.history-meta span:last-child {
  padding-right: 0;
  margin-right: 0;
  border-right: 0;
}

.history-coverage {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 7px;
  color: #8d8174;
  font-size: 11px;
  line-height: 1.4;
}

.history-coverage-label {
  color: #c7b39a;
}

.history-coverage strong {
  color: #f0b56f;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.history-link {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  color: #f0b56f;
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}

.history-link:not(.muted)::after {
  color: currentColor;
  content: 'arrow_outward';
  font-family: 'Material Symbols Outlined';
  font-size: 15px;
  font-weight: 400;
  transition: transform 180ms ease;
}

.history-link:not(.muted):hover::after {
  transform: translate(2px, -2px);
}

.history-item--failed .history-link,
.history-item--canceled .history-link {
  color: #a9998a;
  font-weight: 500;
}

.history-item--running .history-link,
.history-item--queued .history-link {
  color: #c7b39a;
  font-weight: 500;
}

.shot-cover {
  width: 112px;
  height: 72px;
  border-radius: 12px;
  object-fit: cover;
  background: #090909;
  border: 1px solid rgba(201, 163, 113, 0.16);
}

.shot-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8d7558;
  font-size: 11px;
  letter-spacing: 0.18em;
}

.shot-main {
  min-width: 0;
  flex: 1;
}

.shot-title-row,
.history-title {
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.shot-sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

.status-chip.ready {
  background: rgba(87, 205, 145, 0.12);
  color: #8fe3b0;
  border: 1px solid rgba(87, 205, 145, 0.24);
}

.status-chip.missing {
  background: rgba(255, 154, 139, 0.12);
  color: #ffb0a3;
  border: 1px solid rgba(255, 154, 139, 0.24);
}

.status-chip.pending {
  background: rgba(240, 181, 111, 0.12);
  color: #f0b56f;
  border: 1px solid rgba(240, 181, 111, 0.24);
}

.history-link.muted {
  color: #8d8174;
}

.message,
.empty-box,
.state-card,
.history-empty,
.shot-empty {
  border-radius: 18px;
}

.message {
  padding: 12px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

.message.success {
  color: #8fe3b0;
  border-color: rgba(87, 205, 145, 0.24);
}

.message.warning {
  color: #f0b56f;
  border-color: rgba(240, 181, 111, 0.24);
}

.message.error {
  color: #ffb0a3;
  border-color: rgba(255, 154, 139, 0.24);
}

.empty-box,
.state-card {
  gap: 12px;
  padding: 20px;
}

.history-empty,
.shot-empty {
  padding: 18px;
  border: 1px dashed rgba(201, 163, 113, 0.2);
  background: rgba(10, 10, 10, 0.45);
}

.primary-btn,
.ghost-btn {
  min-height: 44px;
  border-radius: 14px;
  padding: 0 18px;
  font-weight: 700;
  transition: all 0.2s ease;
}

.primary-btn {
  border: 1px solid rgba(240, 181, 111, 0.52);
  background: linear-gradient(135deg, #f0b56f, #d97706);
  color: #1d1206;
  box-shadow: 0 16px 36px rgba(217, 119, 6, 0.24);
}

.primary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
  box-shadow: none;
}

.ghost-btn {
  border: 1px solid rgba(201, 163, 113, 0.24);
  background: rgba(9, 10, 8, 0.5);
  color: #f4ede5;
}

@media (max-width: 1100px) {
  .main-grid,
  .list-grid,
  .field-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .export-page {
    padding: 16px;
  }

  .page-top {
    flex-direction: column;
  }

  .history-item,
  .shot-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .regression-sample-row {
    grid-template-columns: 1fr;
  }

  .regression-sample-actions {
    justify-content: flex-start;
  }

  .shot-cover {
    width: 100%;
    height: 180px;
  }
}

/* 交付工作台视觉层：保留上方业务结构，只收紧层级和交互表面。 */
.export-page {
  --export-bg: #111310;
  --export-surface: #181b18;
  --export-surface-raised: #20241f;
  --export-line: rgba(164, 132, 84, 0.24);
  --export-line-soft: rgba(164, 132, 84, 0.13);
  --export-text: #e9e5dd;
  --export-muted: #a9aaa1;
  --export-dim: #777b72;
  --export-accent: #e7a169;
  --export-success: #9fceaa;
  --export-danger: #ee9188;
  min-height: calc(100dvh - 64px);
  padding: 28px 32px 64px;
  background:
    radial-gradient(circle at 92% -10%, rgba(231, 161, 105, 0.08), transparent 28%),
    var(--export-bg);
}

.export-page,
.export-page * {
  box-sizing: border-box;
}

.export-hero {
  max-width: 1480px;
  margin: 0 auto 22px;
  padding: 4px 0 22px;
  border-bottom: 1px solid var(--export-line-soft);
}

.page-context {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--export-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  line-height: 1.4;
  text-transform: uppercase;
}

.page-context-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--export-accent);
  opacity: 0.7;
}

.page-title {
  margin-top: 8px;
  color: var(--export-text);
  font-size: clamp(1.75rem, 3vw, 2.6rem);
  font-weight: 650;
  letter-spacing: -0.035em;
  line-height: 1.05;
}

.page-subtitle {
  max-width: 620px;
  margin-top: 10px;
  color: var(--export-muted);
  font-size: 13px;
  line-height: 1.65;
}

.top-actions {
  gap: 8px;
}

.top-actions .material-symbols-outlined,
.primary-btn .material-symbols-outlined,
.ghost-btn .material-symbols-outlined {
  font-size: 17px;
}

.export-page > .message,
.export-page > .summary-grid,
.export-page > .scene-gap-panel,
.export-page > .main-grid,
.export-page > .regression-panel,
.export-page > .list-grid {
  width: min(1480px, 100%);
  margin-right: auto;
  margin-left: auto;
}

.export-page > .message {
  border-radius: 7px;
  margin-bottom: 10px;
}

.summary-grid {
  display: grid;
  grid-template-columns: 1.25fr repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-bottom: 18px;
  overflow: hidden;
  border: 1px solid var(--export-line-soft);
  background: var(--export-line-soft);
}

.summary-card {
  min-width: 0;
  min-height: 126px;
  border: 0;
  border-radius: 0;
  padding: 18px 18px 16px;
  background: var(--export-surface);
  backdrop-filter: none;
}

.summary-card.highlight {
  background:
    linear-gradient(135deg, rgba(231, 161, 105, 0.14), transparent 72%),
    var(--export-surface);
  box-shadow: none;
}

.summary-label {
  margin-bottom: 14px;
  color: var(--export-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.summary-card.highlight .summary-label {
  color: var(--export-accent);
}

.summary-value {
  margin-bottom: 7px;
  color: var(--export-text);
  font-size: 27px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  letter-spacing: -0.025em;
}

.summary-help {
  max-width: 26ch;
  color: var(--export-dim);
  font-size: 11px;
  line-height: 1.55;
}

.panel {
  border: 1px solid var(--export-line-soft);
  border-radius: 10px;
  padding: 18px;
  background: var(--export-surface);
  backdrop-filter: none;
}

.panel-head {
  margin-bottom: 16px;
  padding-bottom: 13px;
  border-bottom: 1px solid var(--export-line-soft);
}

.panel-head h2,
.latest-export-head h3,
.empty-box h3,
.quality-review-head h3 {
  color: var(--export-text);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.panel-sub,
.quality-review-head p,
.history-sub,
.export-action-sub,
.shot-sub {
  color: var(--export-muted);
  font-size: 12px;
  line-height: 1.6;
}

.panel-tag,
.status-chip {
  height: 26px;
  border-radius: 4px;
  padding: 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.panel-tag {
  border-color: var(--export-line);
  background: rgba(231, 161, 105, 0.08);
  color: var(--export-accent);
}

.main-grid {
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
  gap: 14px;
  margin-bottom: 14px;
}

.list-grid {
  gap: 14px;
}

.field-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.field {
  gap: 6px;
}

.field span,
.review-token-field span {
  color: var(--export-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.field-input,
.review-note,
.review-token-input {
  border: 1px solid var(--export-line-soft);
  border-radius: 6px;
  background: #141714;
  color: var(--export-text);
}

.field-input {
  min-height: 42px;
  border-radius: 6px;
  padding: 0 11px;
}

.static-value {
  font-size: 12px;
}

.field-toggle {
  justify-content: flex-start;
}

.field-toggle .toggle-btn {
  margin-top: 3px;
}

.toggle-btn {
  width: 46px;
  height: 26px;
  border-radius: 5px;
  border-color: var(--export-line);
  background: #242821;
}

.toggle-btn.active {
  border-color: rgba(231, 161, 105, 0.58);
  background: rgba(231, 161, 105, 0.2);
}

.toggle-dot {
  top: 4px;
  left: 4px;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  background: var(--export-muted);
}

.toggle-btn.active .toggle-dot {
  transform: translateX(20px);
  background: var(--export-accent);
}

.export-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.42fr);
  align-items: center;
  gap: 16px;
  padding: 14px;
  border: 1px solid rgba(231, 161, 105, 0.24);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(231, 161, 105, 0.11), transparent 76%),
    #171a16;
}

.export-action-title {
  margin-bottom: 5px;
  color: var(--export-text);
  font-size: 15px;
}

.primary-btn,
.ghost-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 38px;
  border-radius: 6px;
  padding: 0 13px;
  font-size: 12px;
  font-weight: 650;
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    color 180ms ease,
    transform 180ms ease;
}

.primary-btn:hover:not(:disabled),
.ghost-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.primary-btn {
  border: 1px solid transparent;
  background: var(--export-accent);
  color: #21170f;
  box-shadow: none;
}

.primary-btn:hover:not(:disabled) {
  border-color: transparent;
  background: #f2b47a;
}

.ghost-btn {
  border-color: var(--export-line);
  background: rgba(255, 255, 255, 0.025);
  color: var(--export-muted);
}

.ghost-btn:hover:not(:disabled) {
  border-color: rgba(231, 161, 105, 0.62);
  background: rgba(231, 161, 105, 0.08);
  color: var(--export-text);
}

.latest-export {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--export-line-soft);
}

.latest-video {
  max-height: 440px;
  border: 1px solid var(--export-line-soft);
  border-radius: 7px;
  object-fit: contain;
}

.latest-meta {
  gap: 7px;
  margin-top: 2px;
}

.latest-meta span {
  border-right: 1px solid var(--export-line-soft);
  padding-right: 8px;
  color: var(--export-dim);
  font-size: 11px;
}

.latest-meta span:last-child {
  border-right: 0;
}

.quality-review {
  margin-top: 17px;
  padding: 15px;
  border: 1px solid var(--export-line-soft);
  border-radius: 8px;
  background: #151815;
}

.quality-review-head {
  align-items: flex-start;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--export-line-soft);
}

.quality-review-body {
  margin-top: 13px;
}

.review-checklist label {
  min-height: 30px;
  color: var(--export-text);
  font-size: 12px;
}

.review-checklist input,
.review-subchecks input,
.regression-tag-option input {
  accent-color: var(--export-accent);
}

.review-subchecks {
  border-left-color: var(--export-line);
}

.review-note {
  min-height: 74px;
  padding: 9px 10px;
  font-size: 12px;
  line-height: 1.55;
}

.review-note.compact {
  min-height: 54px;
}

.review-token-input {
  min-height: 38px;
  padding: 0 10px;
  font-size: 12px;
}

.review-token-field {
  gap: 6px;
}

.review-actions {
  gap: 8px;
}

.scene-gap-panel {
  margin-bottom: 14px;
}

.scene-gap-list {
  gap: 6px;
}

.scene-gap-item {
  min-height: 30px;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 11px;
}

.history-list,
.shot-list {
  gap: 7px;
}

.history-item,
.shot-item {
  gap: 12px;
  border: 1px solid var(--export-line-soft);
  border-radius: 7px;
  padding: 10px;
  background: #151815;
}

.history-item:hover,
.shot-item:hover {
  border-color: var(--export-line);
  background: var(--export-surface-raised);
}

.history-item {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  padding: 13px 14px;
  background:
    linear-gradient(90deg, rgba(231, 161, 105, 0.035), transparent 32%),
    #151815;
}

.history-item--completed {
  background:
    linear-gradient(90deg, rgba(87, 205, 145, 0.045), transparent 34%),
    #151815;
}

.history-item--failed,
.history-item--canceled {
  background:
    linear-gradient(90deg, rgba(255, 154, 139, 0.035), transparent 34%),
    #151815;
}

.history-main {
  gap: 8px;
}

.history-title {
  margin: 0;
}

.history-identity strong {
  font-size: 14px;
}

.history-meta {
  color: var(--export-muted);
  font-size: 11px;
}

.history-coverage {
  color: var(--export-dim);
  font-size: 11px;
}

.history-coverage-label {
  color: var(--export-muted);
}

.history-coverage strong {
  color: var(--export-text);
  font-size: 12px;
}

.history-link {
  min-height: 30px;
  padding: 0 2px;
  color: var(--export-accent);
  font-size: 11px;
}

.history-link.muted {
  color: var(--export-dim);
}

.shot-cover {
  width: 96px;
  height: 62px;
  border-radius: 4px;
  border-color: var(--export-line-soft);
}

.shot-title-row strong,
.history-title strong {
  color: var(--export-text);
  font-size: 12px;
}

.shot-sub {
  margin-top: 3px;
}

.history-link {
  color: var(--export-accent);
  font-size: 11px;
}

.message,
.empty-box,
.history-empty,
.shot-empty {
  border-radius: 7px;
}

.message {
  padding: 10px 12px;
  font-size: 12px;
}

.empty-box,
.history-empty,
.shot-empty {
  padding: 16px;
  background: #151815;
}

.coverage-chip,
.sample-filter-chip {
  min-height: 28px;
  border-radius: 4px;
  font-size: 11px;
}

.regression-panel {
  margin-bottom: 14px;
}

.production-gate-panel {
  width: min(1480px, 100%);
  margin: 0 auto 14px;
}

.production-gate-disclaimer {
  margin-bottom: 14px;
}

.production-gate-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-bottom: 14px;
  overflow: hidden;
  border: 1px solid var(--export-line-soft);
  background: var(--export-line-soft);
}

.production-gate-kpi {
  min-width: 0;
  min-height: 92px;
  padding: 13px;
  background: #151815;
}

.production-gate-kpi strong {
  display: block;
  margin-bottom: 6px;
  color: var(--export-text);
  font-size: 19px;
  font-weight: 650;
  line-height: 1.25;
}

.production-gate-kpi p {
  margin: 0;
  color: var(--export-muted);
  font-size: 11px;
  line-height: 1.55;
}

.production-stage-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}

.production-stage-row {
  min-width: 0;
  min-height: 74px;
  display: grid;
  align-content: space-between;
  gap: 8px;
  padding: 11px;
  border: 1px solid rgba(238, 145, 136, 0.2);
  border-radius: 7px;
  background: rgba(127, 29, 29, 0.08);
}

.production-stage-row.passed {
  border-color: rgba(159, 206, 170, 0.22);
  background: rgba(87, 205, 145, 0.055);
}

.production-stage-row strong,
.production-action-row strong {
  color: var(--export-text);
  font-size: 12px;
  line-height: 1.35;
}

.production-stage-row span {
  color: var(--export-danger);
  font-size: 11px;
  font-weight: 650;
}

.production-stage-row.passed span {
  color: var(--export-success);
}

.production-action-list,
.production-stage-detail-list {
  display: grid;
  gap: 8px;
}

.production-action-list {
  padding: 12px;
  border: 1px solid var(--export-line-soft);
  border-radius: 7px;
  background: #151815;
}

.production-action-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--export-line-soft);
  border-radius: 6px;
  background: rgba(9, 10, 8, 0.28);
}

.production-action-row p {
  margin: 4px 0 0;
  color: var(--export-muted);
  font-size: 11px;
  line-height: 1.55;
}

.production-gate-footnote {
  margin-top: 10px;
}

.production-stage-detail-list .message {
  margin: 0;
}

.market-quality-panel {
  margin-bottom: 14px;
}

.market-quality-disclaimer {
  margin-bottom: 14px;
}

.market-quality-summary {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 14px;
}

.market-quality-summary .summary-card {
  min-height: 86px;
  padding: 12px;
}

.market-quality-summary .summary-value {
  font-size: 19px;
}

.compact-value {
  font-size: 15px !important;
  line-height: 1.3;
}

.market-quality-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.market-quality-card {
  min-width: 0;
  padding: 13px;
  border: 1px solid var(--export-line-soft);
  border-radius: 7px;
  background: #151815;
}

.market-quality-card-emphasis {
  border-color: rgba(231, 161, 105, 0.35);
  background:
    linear-gradient(135deg, rgba(231, 161, 105, 0.09), transparent 72%),
    #151815;
}

.market-quality-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  color: var(--export-text);
  font-size: 12px;
}

.market-quality-card p {
  margin-top: 5px;
  color: var(--export-muted);
  font-size: 11px;
  line-height: 1.55;
}

.passed-text {
  color: var(--export-success);
  font-size: 11px;
  font-weight: 700;
}

.blocked-text {
  color: var(--export-danger) !important;
  font-size: 11px;
  font-weight: 650;
}

.market-quality-footnote {
  margin-top: 12px;
}

.machine-audit-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--export-line-soft);
}

.machine-audit-row {
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid rgba(159, 206, 170, 0.2);
  border-radius: 7px;
  background: rgba(87, 205, 145, 0.045);
}

.machine-audit-row.blocked {
  border-color: rgba(238, 145, 136, 0.22);
  background: rgba(127, 29, 29, 0.07);
}

.machine-audit-row-head,
.machine-audit-checks {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
}

.machine-audit-row-head {
  justify-content: space-between;
  gap: 12px;
}

.machine-audit-row-head strong {
  color: var(--export-text);
  font-size: 12px;
  font-weight: 650;
}

.machine-audit-checks {
  margin-top: 9px;
}

.machine-audit-check {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  border: 1px solid rgba(238, 145, 136, 0.2);
  border-radius: 4px;
  padding: 0 7px;
  color: var(--export-danger);
  font-size: 10px;
  line-height: 1.3;
}

.machine-audit-check.passed {
  border-color: rgba(159, 206, 170, 0.22);
  color: var(--export-success);
}

.machine-audit-blockers {
  margin-top: 7px;
  overflow-wrap: anywhere;
}

.regression-panel .summary-grid {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.regression-panel .summary-card {
  min-height: 84px;
  padding: 12px;
}

.regression-panel .summary-value {
  font-size: 18px;
}

.regression-tag-editor,
.regression-review-workbench,
.regression-review-navigator,
.regression-review-todo,
.regression-review-evidence-summary,
.regression-review-draft-status,
.regression-review-approval-blockers,
.regression-review-save-scope,
.regression-review-audit,
.regression-report-action,
.production-readiness-card,
.candidate-snapshot {
  border-radius: 7px;
  background: #151815;
}

.regression-sample-row {
  border-radius: 7px;
  border-color: var(--export-line-soft);
  background: #151815;
}

.regression-sample-row.active {
  border-color: rgba(231, 161, 105, 0.58);
  background: rgba(231, 161, 105, 0.07);
}

.platform-evidence-row,
.regression-gap-summary,
.regression-evidence-gaps {
  border-color: var(--export-line-soft);
  background: #151815;
}

@media (max-width: 1100px) {
  .export-page {
    padding-right: 20px;
    padding-left: 20px;
  }

  .summary-grid,
  .regression-panel .summary-grid,
  .market-quality-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .market-quality-grid {
    grid-template-columns: 1fr;
  }

  .production-stage-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .main-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .export-page {
    min-height: calc(100dvh - 64px);
    padding: 18px 14px 42px;
  }

  .export-hero {
    padding-bottom: 17px;
  }

  .page-top {
    align-items: flex-start;
  }

  .top-actions {
    width: 100%;
  }

  .top-actions .ghost-btn {
    flex: 1;
  }

  .summary-grid,
  .regression-panel .summary-grid,
  .market-quality-summary,
  .production-gate-summary {
    grid-template-columns: 1fr 1fr;
  }

  .production-stage-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .production-action-row {
    grid-template-columns: 1fr;
  }

  .production-action-row .ghost-btn {
    width: 100%;
  }

  .summary-card {
    min-height: 108px;
    padding: 13px;
  }

  .summary-value {
    font-size: 22px;
  }

  .export-action {
    grid-template-columns: 1fr;
  }

  .export-action .primary-btn {
    width: 100%;
  }

  .field-grid {
    grid-template-columns: 1fr;
  }
}

@media print {
  :global(body) {
    background: #fff !important;
  }

  :global(body *) {
    visibility: hidden !important;
  }

  .regression-review-print-sheet,
  .regression-review-print-sheet * {
    visibility: visible !important;
  }

  .regression-review-print-sheet {
    display: block !important;
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    box-sizing: border-box;
    padding: 24px;
    color: #111827 !important;
    background: #fff !important;
  }
}

@media screen {
  .export-page {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: calc(100dvh - 64px);
    padding: 26px 32px 72px;
    background:
      radial-gradient(circle at 96% -12%, rgba(231, 161, 105, 0.1), transparent 26%),
      linear-gradient(180deg, #111310 0%, #0d0f0d 100%);
  }

  .export-page > .page-top,
  .export-page > .message,
  .export-page > .summary-grid,
  .export-page > .production-gate-panel,
  .export-page > .market-quality-panel,
  .export-page > .scene-gap-panel,
  .export-page > .main-grid,
  .export-page > .regression-panel,
  .export-page > .list-grid {
    width: min(1480px, 100%);
    margin-right: auto;
    margin-left: auto;
  }

  .export-page > .message--global {
    position: static;
    display: flex;
    align-items: center;
    align-self: flex-start;
    width: fit-content;
    max-width: min(100%, 820px);
    gap: 9px;
    min-height: 38px;
    margin-bottom: 0;
    overflow: visible;
    border-radius: 7px;
    padding: 6px 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  .message--global .message-icon {
    flex: 0 0 auto;
    font-size: 17px;
  }

  .message--global .message-copy {
    min-width: 0;
    flex: 0 1 auto;
    max-width: 58ch;
    line-height: 1.5;
  }

  .message--global .message-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    margin-left: 2px;
  }

  .message--global .message-action {
    min-height: 30px;
    padding: 0 9px;
    font-size: 11px;
  }

  .message-close {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: 5px;
    color: currentColor;
    opacity: 0.72;
    transition:
      border-color 180ms ease,
      background-color 180ms ease,
      opacity 180ms ease;
  }

  .message-close:hover {
    border-color: currentColor;
    background: rgba(255, 255, 255, 0.06);
    opacity: 1;
  }

  .message-close .material-symbols-outlined {
    font-size: 16px;
  }

  .message--global.warning {
    border-color: rgba(240, 181, 111, 0.22);
    background: rgba(240, 181, 111, 0.09);
  }

  .message--global.success {
    border-color: rgba(87, 205, 145, 0.22);
    background: rgba(87, 205, 145, 0.07);
  }

  .message--global.error {
    border-color: rgba(255, 154, 139, 0.22);
    background: rgba(255, 154, 139, 0.08);
  }

  .export-page > .page-top { order: 1; }
  .export-page > .message { order: 2; }
  .export-page > .summary-grid { order: 3; }
  .export-page > .primary-workbench-grid { order: 4; }
  .export-page > .production-gate-panel { order: 5; }
  .export-page > .market-quality-panel { order: 6; }
  .export-page > .scene-gap-panel { order: 7; }
  .export-page > .regression-panel { order: 8; }
  .export-page > .evidence-grid { order: 9; }
  .export-page > .list-grid { order: 10; }

  .export-page > .page-top,
  .export-page > .message,
  .export-page > .summary-grid,
  .export-page > .production-gate-panel,
  .export-page > .market-quality-panel,
  .export-page > .scene-gap-panel,
  .export-page > .main-grid,
  .export-page > .regression-panel,
  .export-page > .list-grid {
    margin-bottom: 0;
  }

  .export-hero {
    position: relative;
    min-height: 148px;
    padding: 12px 4px 24px;
    border-bottom-color: rgba(231, 161, 105, 0.2);
  }

  .export-hero::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 1px;
    background: linear-gradient(90deg, rgba(231, 161, 105, 0.72), rgba(231, 161, 105, 0));
    content: '';
    pointer-events: none;
  }

  .page-context {
    color: var(--export-muted);
    letter-spacing: 0.12em;
  }

  .page-title {
    margin-top: 9px;
    color: var(--export-text);
    font-family: 'Noto Serif SC', 'Songti SC', serif;
    font-size: clamp(2.1rem, 4vw, 3.2rem);
    font-weight: 600;
    letter-spacing: -0.035em;
    line-height: 1.08;
    text-wrap: balance;
  }

  .page-subtitle {
    max-width: 58ch;
    margin-top: 12px;
    color: var(--export-muted);
    font-size: 13px;
  }

  .delivery-hero-state {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-top: 18px;
    border: 1px solid rgba(231, 161, 105, 0.24);
    background: rgba(231, 161, 105, 0.06);
    padding: 8px 11px;
    color: var(--export-muted);
    font-size: 11px;
  }

  .delivery-hero-state strong {
    color: var(--export-accent);
    font-size: 12px;
    font-weight: 700;
  }

  .delivery-hero-state-label {
    color: var(--export-dim);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
  }

  .summary-grid {
    gap: 1px;
  }

  .export-page > .summary-grid {
    grid-template-columns: 1.35fr repeat(3, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid var(--export-line-soft);
    border-radius: 10px;
    background: var(--export-line-soft);
  }

  .export-page > .summary-grid .summary-card {
    min-height: 118px;
    border: 0;
    border-radius: 0;
    padding: 17px 19px;
    background: var(--export-surface);
  }

  .export-page > .summary-grid .summary-card.highlight {
    background:
      linear-gradient(135deg, rgba(231, 161, 105, 0.15), transparent 76%),
      var(--export-surface);
  }

  .export-page > .summary-grid .summary-value {
    font-size: 28px;
  }

  .panel {
    border-color: var(--export-line-soft);
    border-radius: 10px;
    background: rgba(24, 27, 24, 0.92);
    box-shadow:
      0 18px 50px rgba(0, 0, 0, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.015);
  }

  .primary-workbench-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.24fr) minmax(300px, 0.76fr);
    gap: 14px;
    align-items: start;
  }

  .evidence-grid,
  .list-grid {
    display: grid;
  }

  .primary-export-panel,
  .export-history-panel {
    min-width: 0;
  }

  .primary-export-panel {
    border-color: rgba(231, 161, 105, 0.26);
    background:
      linear-gradient(135deg, rgba(231, 161, 105, 0.045), transparent 42%),
      rgba(24, 27, 24, 0.96);
  }

  .export-history-panel {
    background: rgba(20, 23, 20, 0.88);
  }

  .primary-export-panel .panel-head {
    margin-bottom: 20px;
  }

  .primary-export-panel .field-grid {
    margin-bottom: 20px;
  }

  .primary-export-panel .export-action {
    grid-template-columns: minmax(0, 1fr) minmax(210px, 0.46fr);
    align-items: center;
    border-color: rgba(231, 161, 105, 0.32);
    background:
      linear-gradient(105deg, rgba(231, 161, 105, 0.13), transparent 68%),
      #171a16;
  }

  .primary-export-panel .export-action-title {
    font-size: 16px;
  }

  .primary-export-panel .latest-export {
    margin-top: 22px;
    padding-top: 20px;
    border-top-color: var(--export-line);
  }

  .primary-export-panel .latest-video {
    max-height: 360px;
    background: #0a0c0a;
  }

  .production-gate-panel,
  .market-quality-panel,
  .regression-panel {
    padding: 20px 22px;
  }

  .production-gate-panel .panel-head,
  .market-quality-panel .panel-head,
  .regression-panel > .panel-head {
    align-items: center;
    margin-bottom: 14px;
  }

  .production-gate-disclaimer,
  .market-quality-disclaimer {
    margin-bottom: 14px;
  }

  .production-action-list {
    margin-top: 14px;
    border-color: var(--export-line-soft);
    background: rgba(10, 12, 10, 0.28);
  }

  .production-action-row {
    min-height: 62px;
    border-color: var(--export-line-soft);
    background: rgba(21, 24, 21, 0.76);
  }

  .production-action-row--secondary {
    background: rgba(14, 16, 14, 0.58);
  }

  .production-action-more,
  .market-quality-details,
  .machine-audit-details,
  .regression-tag-disclosure,
  .regression-review-records {
    border: 1px solid var(--export-line-soft);
    border-radius: 7px;
    background: rgba(15, 17, 15, 0.48);
  }

  .export-page details > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    min-height: 42px;
    cursor: pointer;
    list-style: none;
    padding: 0 12px;
    color: var(--export-text);
    font-size: 12px;
    font-weight: 650;
    transition:
      background-color 180ms ease,
      color 180ms ease;
  }

  .export-page details > summary::-webkit-details-marker {
    display: none;
  }

  .export-page details > summary::after {
    flex: 0 0 auto;
    color: var(--export-accent);
    content: 'expand_more';
    font-family: 'Material Symbols Outlined';
    font-size: 18px;
    font-weight: 400;
    transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .export-page details[open] > summary::after {
    transform: rotate(180deg);
  }

  .export-page details > summary:hover {
    background: rgba(231, 161, 105, 0.06);
    color: var(--export-accent);
  }

  .production-action-more {
    margin-top: 8px;
  }

  .history-more {
    margin-top: 10px;
    border: 1px solid var(--export-line-soft);
    border-radius: 7px;
    background: rgba(15, 17, 15, 0.48);
  }

  .history-more > summary {
    min-height: 40px;
  }

  .history-more > summary > span {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .history-more > summary strong {
    color: var(--export-text);
    font-size: 12px;
    font-weight: 650;
  }

  .history-more > summary small {
    color: var(--export-dim);
    font-size: 10px;
    font-weight: 400;
  }

  .history-more > summary em {
    flex: 0 0 auto;
    color: var(--export-muted);
    font-size: 11px;
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }

  .history-more .history-list--older {
    margin: 0;
    padding: 0 10px 10px;
    border-top: 1px solid var(--export-line-soft);
  }

  .history-item {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .history-link {
    justify-content: flex-start;
    min-height: 28px;
    padding-top: 8px;
    border-top: 1px solid var(--export-line-soft);
  }

  .production-action-more .production-action-row {
    border-top: 1px solid var(--export-line-soft);
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 0;
  }

  .market-quality-details,
  .machine-audit-details {
    margin-top: 12px;
  }

  .market-quality-grid {
    margin: 0;
    padding: 12px;
    border-top: 1px solid var(--export-line-soft);
    background: rgba(10, 12, 10, 0.22);
  }

  .market-quality-card {
    border-radius: 6px;
    background: rgba(24, 27, 24, 0.86);
  }

  .machine-audit-list {
    margin-top: 0;
    padding: 12px;
    border-top: 1px solid var(--export-line-soft);
  }

  .machine-audit-list > .history-sub {
    margin: 0 0 10px;
  }

  .machine-audit-row {
    background: rgba(21, 24, 21, 0.72);
  }

  .scene-gap-panel {
    padding: 18px 20px;
  }

  .regression-panel {
    background:
      linear-gradient(135deg, rgba(231, 161, 105, 0.035), transparent 38%),
      rgba(24, 27, 24, 0.94);
  }

  .regression-panel > .summary-grid {
    margin-bottom: 14px;
  }

  .regression-workbench-grid {
    display: grid;
    grid-template-areas: 'list detail';
    grid-template-columns: minmax(340px, 0.42fr) minmax(0, 0.58fr);
    gap: 16px;
    align-items: start;
    margin-top: 14px;
  }

  .regression-sample-list {
    grid-area: list;
    min-width: 0;
    margin: 0;
    padding: 14px;
    border: 1px solid var(--export-line-soft);
    border-radius: 8px;
    background: rgba(13, 15, 13, 0.56);
  }

  .regression-review-workbench {
    grid-area: detail;
    min-width: 0;
    margin: 0;
    padding: 16px;
    border-color: rgba(231, 161, 105, 0.24);
    border-radius: 8px;
    background:
      linear-gradient(135deg, rgba(231, 161, 105, 0.055), transparent 36%),
      #151815;
  }

  .regression-sample-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
    border-radius: 6px;
    background: rgba(21, 24, 21, 0.76);
  }

  .regression-sample-row + .regression-sample-row {
    margin-top: 7px;
  }

  .regression-sample-title strong {
    color: var(--export-text);
    font-size: 12px;
  }

  .regression-sample-actions {
    justify-content: flex-start;
    padding-top: 10px;
    border-top: 1px solid var(--export-line-soft);
  }

  .regression-tag-disclosure {
    margin-top: 14px;
  }

  .regression-tag-editor {
    margin: 0;
    border-top: 1px solid var(--export-line-soft);
    border-radius: 0;
    padding: 14px;
    background: rgba(15, 17, 15, 0.45);
  }

  .regression-review-records {
    margin-top: 14px;
    background: rgba(10, 12, 10, 0.32);
  }

  .regression-review-records > summary {
    min-height: 44px;
  }

  .regression-review-records > :not(summary) {
    margin-right: 12px;
    margin-left: 12px;
  }

  .regression-review-records > :not(summary):first-of-type {
    margin-top: 12px;
  }

  .regression-review-records > :last-child {
    margin-bottom: 12px;
  }

  .regression-review-target {
    margin-top: 14px;
  }

  .regression-review-target .compact-video {
    max-height: 280px;
    background: #0b0d0b;
  }

  .regression-review-todo {
    margin-top: 14px;
    border-color: rgba(231, 161, 105, 0.22);
    background: rgba(231, 161, 105, 0.045);
  }

  .regression-review-workbench > .review-checklist {
    margin-top: 14px;
  }

  .regression-review-workbench .review-note,
  .primary-export-panel .review-note {
    border-radius: 5px;
  }

  .evidence-grid {
    grid-template-columns: minmax(280px, 0.84fr) minmax(0, 1.16fr);
    grid-template-areas:
      'cost release'
      'platform release';
  }

  .evidence-grid .panel {
    align-self: start;
  }

  .evidence-grid #cost-ledger-gate {
    grid-area: cost;
  }

  .evidence-grid #platform-validation-gate {
    grid-area: platform;
  }

  .evidence-grid #release-compliance-gate {
    grid-area: release;
    border-color: rgba(231, 161, 105, 0.24);
  }

  .cost-ledger-summary {
    grid-template-columns: minmax(0, 1.55fr) minmax(0, 0.8fr) minmax(0, 0.8fr);
    margin: 0;
  }

  .evidence-grid .cost-ledger-summary .summary-card {
    min-height: 112px;
    padding: 14px;
  }

  .cost-ledger-summary .summary-label {
    margin-bottom: 10px;
    letter-spacing: 0.08em;
  }

  .cost-ledger-summary .summary-value {
    margin-bottom: 6px;
    font-size: 26px;
    line-height: 1.1;
  }

  .cost-ledger-summary .cost-ledger-value.is-empty {
    max-width: 12ch;
    color: var(--export-muted);
    font-size: 17px;
    letter-spacing: 0;
    line-height: 1.35;
  }

  .cost-ledger-metric-unpriced .summary-value {
    color: var(--export-accent);
  }

  .cost-ledger-metric-foot {
    display: block;
    color: var(--export-dim);
    font-size: 10px;
    line-height: 1.45;
  }

  .cost-ledger-meta {
    display: grid;
    gap: 8px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--export-line-soft);
  }

  .cost-ledger-meta p {
    display: flex;
    gap: 10px;
    align-items: baseline;
    margin: 0;
  }

  .cost-ledger-meta-label {
    flex: 0 0 auto;
    color: var(--export-text);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .release-compliance-panel {
    display: flex;
    flex-direction: column;
  }

  .release-compliance-panel .message {
    margin-bottom: 8px;
  }

  .release-compliance-panel .quality-issues {
    display: grid;
    gap: 8px;
  }

  .release-compliance-panel .quality-issues .message {
    margin-bottom: 0;
  }

  .compliance-section-heading {
    color: var(--export-text);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .compliance-review-section {
    display: grid;
    gap: 10px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--export-line-soft);
  }

  .review-checklist .compliance-label-input {
    width: 100%;
    height: 42px;
    min-height: 42px;
    resize: none;
  }

  .compliance-platforms {
    gap: 0;
    margin: 14px 0 0;
    padding-top: 14px;
    border-top: 1px solid var(--export-line-soft);
  }

  .compliance-platforms > .compliance-section-heading {
    margin-bottom: 2px;
  }

  .compliance-platforms .platform-evidence-row:first-of-type {
    border-top: 0;
  }

  .compliance-save-section {
    display: grid;
    gap: 12px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--export-line-soft);
  }

  .evidence-grid .review-token-input,
  .evidence-grid .review-note {
    border-color: var(--export-line-soft);
  }

  .list-grid {
    gap: 14px;
  }

  .list-grid .panel {
    min-width: 0;
  }

  .export-page input:focus-visible,
  .export-page textarea:focus-visible,
  .export-page select:focus-visible,
  .export-page button:focus-visible,
  .export-page summary:focus-visible {
    outline: 2px solid var(--export-accent);
    outline-offset: 3px;
  }

  @media (max-width: 1100px) {
    .export-page {
      padding-right: 20px;
      padding-left: 20px;
    }

    .primary-workbench-grid,
    .evidence-grid {
      grid-template-columns: 1fr;
    }

    .evidence-grid {
      grid-template-areas:
        'cost'
        'release'
        'platform';
    }

    .regression-workbench-grid {
      grid-template-areas:
        'detail'
        'list';
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .export-page {
      gap: 10px;
      padding: 18px 14px 44px;
    }

    .export-page > .message--global {
      align-items: flex-start;
      flex-wrap: wrap;
      width: 100%;
      max-width: 100%;
    }

    .message--global .message-actions {
      width: 100%;
      justify-content: flex-end;
      margin-left: 26px;
    }

    .export-hero {
      min-height: 220px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding-right: 0;
      padding-left: 0;
    }

    .export-hero > div:first-child {
      width: 100%;
    }

    .export-hero .top-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      width: 100%;
    }

    .delivery-hero-state {
      width: 100%;
      flex-wrap: wrap;
    }

    .export-page > .summary-grid {
      grid-template-columns: 1fr 1fr;
    }

    .export-page > .summary-grid .summary-card {
      min-height: 100px;
      padding: 13px;
    }

    .primary-export-panel .export-action {
      grid-template-columns: 1fr;
    }

    .primary-export-panel .export-action .primary-btn {
      width: 100%;
    }

    .production-gate-panel,
    .market-quality-panel,
    .regression-panel {
      padding: 16px;
    }

    .regression-workbench-grid {
      margin-top: 10px;
    }

    .regression-review-workbench,
    .regression-sample-list {
      padding: 12px;
    }

    .export-page details > summary {
      min-height: 46px;
      padding-right: 10px;
      padding-left: 10px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .export-page details > summary::after,
    .export-page .toggle-dot,
    .export-page button,
    .export-page a {
      transition: none !important;
    }
  }
}
</style>
