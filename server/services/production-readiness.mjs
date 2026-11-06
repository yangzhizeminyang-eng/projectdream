import { inspectObjectStorageReadiness } from './object-storage.mjs'

const DEFAULT_REQUIRED_PLATFORMS = ['hongguo', 'douyin']
const SUBTITLE_BLOCKER_CODES = new Set([
  'subtitle-cue-count-mismatch',
  'subtitle-text-mismatch',
  'subtitle-timeline-drift',
  'subtitle-out-of-range',
  'subtitle-overlap',
  'subtitle-unsafe-area',
  'subtitle-missing',
])
const CHARACTER_VERSION_BLOCKER_CODES = new Set([
  'character-version-evidence-missing',
  'character-version-mismatch',
])

function truthyEnv(value) {
  return ['1', 'true', 'yes', 'enabled', 'on'].includes(
    String(value || '').trim().toLowerCase(),
  )
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function isLocalHostUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(url.hostname)
  } catch {
    return false
  }
}

function countByCodes(blockerCounts = {}, codes = new Set()) {
  return Object.entries(blockerCounts || {}).reduce((total, [code, count]) => (
    codes.has(code) ? total + Math.max(0, Number(count) || 0) : total
  ), 0)
}

function addBlocker(blockers, code, message, extra = {}) {
  blockers.push({
    code,
    message,
    ...extra,
  })
}

function stage(passed, summary = {}, blockers = []) {
  return {
    status: passed ? 'passed' : 'blocked',
    passed,
    summary,
    blockers,
  }
}

function platformEvidenceComplete(releaseCompliance = {}) {
  const compliance = releaseCompliance.checks?.platformCompliance || {}
  const platforms = Array.isArray(releaseCompliance.platforms) && releaseCompliance.platforms.length
    ? releaseCompliance.platforms
    : DEFAULT_REQUIRED_PLATFORMS
  const evidence = Array.isArray(releaseCompliance.aiDisclosure?.platformEvidence)
    ? releaseCompliance.aiDisclosure.platformEvidence
    : Array.isArray(compliance.evidence)
      ? compliance.evidence
      : []
  const byPlatform = new Map(evidence.map((item) => [String(item?.platform || '').trim(), item]))
  const missing = platforms.filter((platform) => {
    const item = byPlatform.get(String(platform))
    return !(
      item?.aiLabelReviewed === true &&
      item?.copyrightFieldsReviewed === true &&
      String(item?.ruleReviewNote || '').trim()
    )
  })
  return {
    passed: missing.length === 0 && releaseCompliance.aiDisclosure?.disclosureConfirmed === true,
    platforms,
    missing,
    evidenceCount: evidence.length,
  }
}

function buildActionQueue(blockers) {
  const actionByCode = {
    'regression-production-not-ready': {
      code: 'complete-ten-final-edit-regression',
      label: '补齐 10 条真实终剪回归',
      message: '逐条完成 1080x1920 / 24fps / 48kHz 终剪、机器质检和人工复核。',
    },
    'regression-coverage-incomplete': {
      code: 'tag-or-produce-missing-coverage',
      label: '补六类样本覆盖',
      message: '补齐空镜头、单人、双人、对白、旁白、动作镜头覆盖。',
    },
    'missing-media-objects': {
      code: 'repair-missing-media',
      label: '修复缺失媒体对象',
      message: '先只读定位缺失 export，再逐条从本地/COS/可重新生成链路恢复。',
    },
    'subtitle-audit-failed': {
      code: 'fix-subtitle-cues',
      label: '修复字幕数量、文字和时间轴',
      message: '重新核对 SRT、finalEditDraft.subtitleCues 和导出时间线。',
    },
    'character-version-evidence-missing': {
      code: 'regenerate-character-evidence-sample',
      label: '补角色版本证据',
      message: '历史缺证据不能伪造；用新链路生成带 character_evidence_json 的样本。',
    },
    'market-machine-quality-not-ready': {
      code: 'rerun-market-quality-gates',
      label: '重跑机器代理质检',
      message: '只对单条或小批量已存在成片跑 ffprobe、字幕、音频、人物和节奏审计。',
    },
    'release-compliance-blocked': {
      code: 'complete-release-compliance-package',
      label: '补发布合规包',
      message: '完成技术、字幕、音频授权、人工终审、AI 标识和平台字段证据。',
    },
    'platform-evidence-incomplete': {
      code: 'complete-platform-evidence',
      label: '补红果/抖音平台证据',
      message: '保存 AI 标识、版权字段和投稿规则核验证据。',
    },
    'cdn-not-configured': {
      code: 'configure-cdn',
      label: '配置 CDN 播放域名',
      message: '用正式 HTTPS CDN 域名替代本机或 COS 原始域名，并验证播放。',
    },
    'backup-not-verified': {
      code: 'verify-storage-backup',
      label: '验证对象备份',
      message: '执行备份和校验记录，保存最近一次验证时间。',
    },
    'cross-machine-restore-not-verified': {
      code: 'verify-cross-machine-restore',
      label: '演练跨机器恢复',
      message: '在另一环境用数据库和对象存储恢复并播放样片。',
    },
    'cost-pricing-incomplete': {
      code: 'complete-cost-ledger-pricing',
      label: '补成本计价',
      message: '给生成、音频和导出成本配置价格，消除 unpriced 项。',
    },
    'platform-publication-data-missing': {
      code: 'publish-controlled-episodes',
      label: '真实小批量发布',
      message: '发布至少三条/三集样本，留存平台后台证据。',
    },
    'platform-metrics-missing': {
      code: 'import-platform-metrics',
      label: '导入平台数据',
      message: '导入播放、完播、跳出、互动和转化指标。',
    },
    'revenue-evidence-missing': {
      code: 'record-revenue-evidence',
      label: '记录收入证据',
      message: '只有真实平台收入或结算截图/数据入库后，才能说有收入验证。',
    },
  }
  const seen = new Set()
  return blockers
    .map((blocker) => actionByCode[blocker.code])
    .filter(Boolean)
    .filter((action) => {
      if (seen.has(action.code)) return false
      seen.add(action.code)
      return true
    })
}

export function buildStorageOperationsReadiness(env = process.env) {
  const objectStorage = inspectObjectStorageReadiness(env)
  const publicBaseUrl = String(env.OBJECT_STORAGE_PUBLIC_BASE_URL || '').trim()
  const cdnReady =
    isHttpUrl(publicBaseUrl) &&
    !isLocalHostUrl(publicBaseUrl) &&
    (
      truthyEnv(env.OBJECT_STORAGE_CDN_ENABLED) ||
      truthyEnv(env.CDN_ENABLED) ||
      !/\.cos\./i.test(publicBaseUrl)
    )
  const backupReady =
    truthyEnv(env.OBJECT_STORAGE_BACKUP_ENABLED) &&
    Boolean(String(env.OBJECT_STORAGE_BACKUP_LAST_VERIFIED_AT || '').trim())
  const restoreReady = Boolean(String(env.CROSS_MACHINE_RESTORE_LAST_VERIFIED_AT || '').trim())

  return {
    objectStorage,
    cdn: {
      ready: cdnReady,
      publicBaseUrl: publicBaseUrl && isHttpUrl(publicBaseUrl) ? publicBaseUrl : null,
    },
    backup: {
      ready: backupReady,
      lastVerifiedAt: String(env.OBJECT_STORAGE_BACKUP_LAST_VERIFIED_AT || '').trim() || null,
    },
    crossMachineRestore: {
      ready: restoreReady,
      lastVerifiedAt: String(env.CROSS_MACHINE_RESTORE_LAST_VERIFIED_AT || '').trim() || null,
    },
  }
}

export function buildProductionReadinessReport({
  projectId,
  finalQualityRegression = null,
  marketQualityAudit = null,
  releaseCompliance = null,
  costLedger = null,
  storageOperations = null,
  platformValidation = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const blockers = []
  const regressionSummary = finalQualityRegression?.summary || {}
  const regressionProduction = finalQualityRegression?.productionReadiness || {}
  const regressionBlockers = []
  if (regressionProduction.ready !== true) {
    addBlocker(
      regressionBlockers,
      'regression-production-not-ready',
      '10 条真实终剪回归尚未同时满足技术通过、人工批准和证据完整。',
      { upstreamBlockers: regressionProduction.blockers || [] },
    )
  }
  const missingCoverage = Array.isArray(finalQualityRegression?.coverage?.missingBuckets)
    ? finalQualityRegression.coverage.missingBuckets
    : []
  if (missingCoverage.length > 0) {
    addBlocker(
      regressionBlockers,
      'regression-coverage-incomplete',
      `终剪回归六类样本覆盖仍缺：${missingCoverage.map((item) => item.label || item.key).join('、')}。`,
      { missingBuckets: missingCoverage.map((item) => item.key || item.label).filter(Boolean) },
    )
  }
  blockers.push(...regressionBlockers)

  const marketSummary = marketQualityAudit?.summary || {}
  const marketBlockers = []
  const missingMediaCount = Number(marketSummary.storage?.missingCount || 0)
  if (missingMediaCount > 0) {
    addBlocker(
      marketBlockers,
      'missing-media-objects',
      `仍有 ${missingMediaCount} 条媒体对象不可读或缺失。`,
      { exportIds: marketSummary.storage?.missingExportIds || [] },
    )
  }
  const subtitleBlockerCount = countByCodes(marketSummary.blockerCounts, SUBTITLE_BLOCKER_CODES)
  if (subtitleBlockerCount > 0) {
    addBlocker(
      marketBlockers,
      'subtitle-audit-failed',
      `字幕数量、文字或时间轴仍有 ${subtitleBlockerCount} 项机器审计阻塞。`,
      { count: subtitleBlockerCount },
    )
  }
  const characterVersionBlockerCount = countByCodes(
    marketSummary.blockerCounts,
    CHARACTER_VERSION_BLOCKER_CODES,
  )
  if (characterVersionBlockerCount > 0) {
    addBlocker(
      marketBlockers,
      'character-version-evidence-missing',
      `角色版本证据仍有 ${characterVersionBlockerCount} 项阻塞，不能伪造历史证据。`,
      { count: characterVersionBlockerCount },
    )
  }
  if (marketSummary.tenSampleReadiness?.technicalMachineReady !== true) {
    addBlocker(
      marketBlockers,
      'market-machine-quality-not-ready',
      '10 条样本的机器代理质检还未全部通过。',
      {
        auditableSampleCount: Number(marketSummary.tenSampleReadiness?.auditableSampleCount || 0),
        technicalProxyPassedCount: Number(
          marketSummary.tenSampleReadiness?.technicalProxyPassedCount || 0,
        ),
      },
    )
  }
  blockers.push(...marketBlockers)

  const releaseBlockers = []
  if (releaseCompliance?.canPublish !== true) {
    addBlocker(
      releaseBlockers,
      'release-compliance-blocked',
      '发布合规包还没有达到内部发布候选标准。',
      { upstreamIssues: releaseCompliance?.blockingIssues || [] },
    )
  }
  const platformEvidence = platformEvidenceComplete(releaseCompliance || {})
  if (!platformEvidence.passed) {
    addBlocker(
      releaseBlockers,
      'platform-evidence-incomplete',
      '红果、抖音等目标平台的 AI 标识、版权字段或规则备注证据仍不完整。',
      { missingPlatforms: platformEvidence.missing },
    )
  }
  blockers.push(...releaseBlockers)

  const ops = storageOperations || buildStorageOperationsReadiness()
  const storageBlockers = []
  if (ops.objectStorage?.ready !== true) {
    addBlocker(
      storageBlockers,
      'object-storage-not-ready',
      '对象存储生产配置不完整。',
      { missing: ops.objectStorage?.missing || [] },
    )
  }
  if (ops.cdn?.ready !== true) {
    addBlocker(storageBlockers, 'cdn-not-configured', '正式 CDN 播放域名尚未配置或验证。')
  }
  if (ops.backup?.ready !== true) {
    addBlocker(storageBlockers, 'backup-not-verified', '对象存储备份策略尚未完成最近一次验证。')
  }
  if (ops.crossMachineRestore?.ready !== true) {
    addBlocker(
      storageBlockers,
      'cross-machine-restore-not-verified',
      '跨机器恢复演练尚未完成，不能证明换机器可恢复生产。',
    )
  }
  blockers.push(...storageBlockers)

  const costSummary = costLedger?.summary || {}
  const costBlockers = []
  if (
    costLedger?.pricingCatalogConfigured !== true ||
    Number(costSummary.unpricedEntryCount || 0) > 0
  ) {
    addBlocker(
      costBlockers,
      'cost-pricing-incomplete',
      '成本台账仍有未计价项或价格目录未配置，不能稳定核算单条成本。',
      {
        unpricedEntryCount: Number(costSummary.unpricedEntryCount || 0),
        pricingCatalogConfigured: costLedger?.pricingCatalogConfigured === true,
      },
    )
  }
  blockers.push(...costBlockers)

  const platform = platformValidation || {}
  const platformBlockers = []
  if (Number(platform.publishedEpisodeCount || 0) < 3) {
    addBlocker(
      platformBlockers,
      'platform-publication-data-missing',
      '还没有至少三条/三集真实平台发布证据。',
      { publishedEpisodeCount: Number(platform.publishedEpisodeCount || 0) },
    )
  }
  if (platform.metricsImported !== true) {
    addBlocker(
      platformBlockers,
      'platform-metrics-missing',
      '还没有导入播放、完播、跳出、评论或转化等真实平台数据。',
    )
  }
  if (platform.revenueRecorded !== true) {
    addBlocker(
      platformBlockers,
      'revenue-evidence-missing',
      '还没有真实收入或结算证据，不能宣称稳定赚钱。',
    )
  }
  blockers.push(...platformBlockers)

  const stages = {
    finalEditRegression: stage(regressionBlockers.length === 0, {
      sampleCount: Number(regressionSummary.sampleCount || 0),
      requiredSampleCount: Number(regressionSummary.requiredSampleCount || 10),
      automaticPassedCount: Number(regressionSummary.automaticPassedCount || 0),
      approvedCount: Number(regressionSummary.approvedCount || 0),
      reviewEvidenceGapCount: Number(regressionSummary.reviewEvidenceGapCount || 0),
    }, regressionBlockers),
    marketMachineQuality: stage(marketBlockers.length === 0, {
      auditableSampleCount: Number(marketSummary.tenSampleReadiness?.auditableSampleCount || 0),
      technicalProxyPassedCount: Number(
        marketSummary.tenSampleReadiness?.technicalProxyPassedCount || 0,
      ),
      missingMediaCount,
      subtitleBlockerCount,
      characterVersionBlockerCount,
    }, marketBlockers),
    releaseCompliance: stage(releaseBlockers.length === 0, {
      canPublish: releaseCompliance?.canPublish === true,
      missingPlatforms: platformEvidence.missing,
      evidenceCount: platformEvidence.evidenceCount,
    }, releaseBlockers),
    storageOperations: stage(storageBlockers.length === 0, {
      provider: ops.objectStorage?.provider || null,
      cdnReady: ops.cdn?.ready === true,
      backupReady: ops.backup?.ready === true,
      crossMachineRestoreReady: ops.crossMachineRestore?.ready === true,
    }, storageBlockers),
    costControl: stage(costBlockers.length === 0, {
      entryCount: Number(costSummary.entryCount || 0),
      unpricedEntryCount: Number(costSummary.unpricedEntryCount || 0),
      pricingCatalogConfigured: costLedger?.pricingCatalogConfigured === true,
    }, costBlockers),
    platformValidation: stage(platformBlockers.length === 0, {
      publishedEpisodeCount: Number(platform.publishedEpisodeCount || 0),
      metricsImported: platform.metricsImported === true,
      revenueRecorded: platform.revenueRecorded === true,
    }, platformBlockers),
  }

  const releaseCandidateReady = [
    stages.finalEditRegression,
    stages.marketMachineQuality,
    stages.releaseCompliance,
    stages.storageOperations,
    stages.costControl,
  ].every((item) => item.passed)
  const stableRevenueReady = releaseCandidateReady && stages.platformValidation.passed

  return {
    projectId: Number(projectId) || 0,
    generatedAt,
    status: stableRevenueReady
      ? 'stable-revenue-evidence-ready'
      : releaseCandidateReady
        ? 'ready-for-controlled-publish'
        : 'blocked',
    releaseCandidateReady,
    stableRevenueReady,
    stages,
    blockers,
    actionQueue: buildActionQueue(blockers),
    disclaimer:
      '该报告只聚合已有证据；不会替代真人完整播放复核、平台审核，也不能承诺稳定收入。',
  }
}
