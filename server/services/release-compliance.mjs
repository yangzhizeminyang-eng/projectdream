import { createHash } from 'node:crypto'
import { hasCompleteAudioHumanEvidence } from './final-quality-review.mjs'

const ALLOWED_LICENSE_STATUSES = new Set(['authorized', 'owned', 'public-domain'])
const REVIEW_CHECKS = ['visualReviewed', 'subtitleReviewed', 'audioReviewed']
const REVIEW_EVIDENCE_CHECKS = ['visualEvidence', 'subtitleEvidence', 'audioEvidence']
const RELEASE_COMPLIANCE_CONFIRMATION_TOKEN = 'CONFIRM_RELEASE_COMPLIANCE_REVIEW'
const RELEASE_COMPLIANCE_SNAPSHOT_VERSION = 'release-compliance-v1'
const RELEASE_CANDIDATE_SNAPSHOT_VERSION = 'release-candidate-snapshot-v1'

function normalizePlatforms(platforms) {
  return (Array.isArray(platforms) ? platforms : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function normalizeAudioAssets(audioAssets, { strictLicenseStatus = true } = {}) {
  return (Array.isArray(audioAssets) ? audioAssets : []).map((asset) => {
    const licenseStatus = String(asset?.licenseStatus ?? asset?.license_status ?? '').trim()
    if (
      strictLicenseStatus &&
      licenseStatus &&
      !ALLOWED_LICENSE_STATUSES.has(licenseStatus)
    ) {
      throw new Error(`授权状态无效：${licenseStatus}`)
    }
    return {
      id: Number(asset?.id) || null,
      trackType: String(asset?.trackType ?? asset?.track_type ?? '').trim(),
      title: String(asset?.title || asset?.name || asset?.id || '未命名素材').trim(),
      licenseStatus,
      licenseEvidence: String(asset?.licenseEvidence ?? asset?.license_evidence ?? '').trim(),
      sourceName: String(asset?.sourceName ?? asset?.source_name ?? '').trim() || null,
    }
  })
}

function normalizePlatformEvidence(platformEvidence) {
  return (Array.isArray(platformEvidence) ? platformEvidence : [])
    .map((item) => ({
      platform: String(item?.platform || '').trim(),
      aiLabelReviewed: item?.aiLabelReviewed === true,
      copyrightFieldsReviewed: item?.copyrightFieldsReviewed === true,
      ruleReviewNote: String(item?.ruleReviewNote || '').trim() || null,
    }))
    .filter((item) => item.platform)
}

function normalizeAudioChecklist(evidence = {}) {
  return {
    listeningConfirmed: evidence?.listeningConfirmed === true,
    clarityReviewed: evidence?.clarityReviewed === true,
    loudnessReviewed: evidence?.loudnessReviewed === true,
    clippingReviewed: evidence?.clippingReviewed === true,
    syncReviewed: evidence?.syncReviewed === true,
    syncNotApplicable: evidence?.syncNotApplicable === true,
  }
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra }
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function buildReleaseComplianceAudit(packageData) {
  const evidenceHash = createHash('sha256')
    .update(stableJson({ snapshotVersion: RELEASE_COMPLIANCE_SNAPSHOT_VERSION, packageData }))
    .digest('hex')
  return {
    snapshotVersion: RELEASE_COMPLIANCE_SNAPSHOT_VERSION,
    evidenceHash,
  }
}

export function buildReleaseCandidateSnapshot(compliancePackage = {}, options = {}) {
  if (
    compliancePackage.status !== 'release-candidate' ||
    compliancePackage.canPublish !== true ||
    !compliancePackage.audit?.evidenceHash
  ) {
    return null
  }

  const snapshot = {
    snapshotVersion: RELEASE_CANDIDATE_SNAPSHOT_VERSION,
    projectId: Number(compliancePackage.projectId) || 0,
    exportId: Number(compliancePackage.exportId) || 0,
    evidenceHash: compliancePackage.audit.evidenceHash,
    platforms: normalizePlatforms(compliancePackage.platforms),
    technicalSpec: {
      format: compliancePackage.checks?.technical?.spec?.format || null,
      resolution: compliancePackage.checks?.technical?.spec?.resolution || null,
      frameRate: Number(compliancePackage.checks?.technical?.spec?.frameRate) || null,
      videoCodec: compliancePackage.checks?.technical?.spec?.videoCodec || null,
      audioCodec: compliancePackage.checks?.technical?.spec?.audioCodec || null,
    },
    subtitle: {
      hasSpeech: compliancePackage.checks?.subtitle?.hasSpeech === true,
      cueCount: Number(compliancePackage.checks?.subtitle?.cueCount) || 0,
      burnedIn: compliancePackage.checks?.subtitle?.burnedIn === true,
    },
    humanReviewEvidence: {
      visual: compliancePackage.checks?.humanReview?.checklist?.visualEvidence?.note || null,
      subtitle: compliancePackage.checks?.humanReview?.checklist?.subtitleEvidence?.note || null,
      audio: compliancePackage.checks?.humanReview?.checklist?.audioEvidence?.note || null,
      audioChecklist: normalizeAudioChecklist(
        compliancePackage.checks?.humanReview?.checklist?.audioEvidence,
      ),
    },
    aiDisclosure: {
      isAiGenerated: compliancePackage.aiDisclosure?.isAiGenerated === true,
      disclosureConfirmed: compliancePackage.aiDisclosure?.disclosureConfirmed === true,
      label: compliancePackage.aiDisclosure?.label || null,
      platformEvidence: normalizePlatformEvidence(
        compliancePackage.aiDisclosure?.platformEvidence,
      ),
    },
  }

  if (options.generatedAt) {
    snapshot.generatedAt = String(options.generatedAt)
  }

  return snapshot
}

export function assertReleaseComplianceSaveConfirmation(raw = {}) {
  const aiDisclosure =
    raw.aiDisclosure && typeof raw.aiDisclosure === 'object' ? raw.aiDisclosure : raw
  const platformEvidence = Array.isArray(aiDisclosure.platformEvidence)
    ? aiDisclosure.platformEvidence
    : []
  const hasPlatformReviewEvidence = platformEvidence.some(
    (item) =>
      item?.aiLabelReviewed === true ||
      item?.copyrightFieldsReviewed === true ||
      String(item?.ruleReviewNote || '').trim(),
  )
  const requiresConfirmation =
    aiDisclosure.disclosureConfirmed === true || hasPlatformReviewEvidence
  if (
    requiresConfirmation &&
    (raw.confirm !== true ||
      String(raw.confirmationToken || '').trim() !== RELEASE_COMPLIANCE_CONFIRMATION_TOKEN)
  ) {
    throw new Error('保存发布合规确认前必须输入精确发布合规确认口令')
  }
}

export function normalizeReleaseComplianceInput(raw = {}, options = {}) {
  return {
    projectId: Number(raw.projectId ?? raw.project_id) || 0,
    exportId: Number(raw.exportId ?? raw.export_id) || 0,
    exportRecord: raw.exportRecord || {},
    subtitle: raw.subtitle || {},
    audioAssets: normalizeAudioAssets(raw.audioAssets, options),
    quality: raw.quality || {},
    aiDisclosure: {
      ...(raw.aiDisclosure || {}),
      platformEvidence: normalizePlatformEvidence(raw.aiDisclosure?.platformEvidence),
    },
    platforms: normalizePlatforms(raw.platforms),
  }
}

export function buildReleaseComplianceGapSummary(compliancePackage = {}) {
  const blockingIssues = Array.isArray(compliancePackage.blockingIssues)
    ? compliancePackage.blockingIssues
    : []
  const missingPlatforms = Array.isArray(
    compliancePackage.checks?.platformCompliance?.missingPlatforms,
  )
    ? compliancePackage.checks.platformCompliance.missingPlatforms
    : []
  const platformEvidence = Array.isArray(
    compliancePackage.aiDisclosure?.platformEvidence,
  )
    ? compliancePackage.aiDisclosure.platformEvidence
    : []

  return {
    status: String(compliancePackage.status || 'blocked'),
    canPublish: compliancePackage.canPublish === true,
    evidenceHash: String(compliancePackage.audit?.evidenceHash || '').trim() || null,
    blockingIssueCodes: blockingIssues
      .map((item) => String(item?.code || '').trim())
      .filter(Boolean),
    missingPlatforms,
    aiDisclosureConfirmed:
      compliancePackage.aiDisclosure?.disclosureConfirmed === true,
    aiDisclosureLabel:
      String(compliancePackage.aiDisclosure?.label || '').trim() || null,
    humanReviewPassed: compliancePackage.checks?.humanReview?.passed === true,
    reviewDecision: compliancePackage.checks?.humanReview?.reviewDecision || null,
    platformEvidenceCount: platformEvidence.length,
    disclaimer:
      '只读缺口摘要，不代表平台审核通过，也不会自动写入或批准任何证据。',
  }
}

export function buildReleaseCompliancePackage(raw = {}) {
  const input = normalizeReleaseComplianceInput(raw, { strictLicenseStatus: false })
  const exportRecord = input.exportRecord
  const subtitle = input.subtitle
  const quality = input.quality
  const aiDisclosure = input.aiDisclosure
  const blockingIssues = []
  const warnings = []

  const technicalPassed = Boolean(
    exportRecord.status === 'completed' &&
      exportRecord.videoUrl &&
      exportRecord.technicalQualityPassed === true,
  )
  if (!technicalPassed) {
    blockingIssues.push(
      issue('technical-quality-incomplete', '成片未完成或自动技术质检未通过，不能进入发布包。'),
    )
  }

  const subtitlePassed = Boolean(
    subtitle.hasSpeech !== true ||
      (subtitle.hasValidCues === true && subtitle.burnedIn === true),
  )
  if (!subtitlePassed) {
    blockingIssues.push(
      issue('subtitle-incomplete', '存在对白或旁白时，必须确认有效字幕并烧录进正式导出。'),
    )
  }

  const licensedAudioIssues = input.audioAssets
    .filter((asset) => ['music', 'sfx'].includes(asset.trackType))
    .filter(
      (asset) =>
        !ALLOWED_LICENSE_STATUSES.has(asset.licenseStatus) ||
        !asset.licenseEvidence,
    )
    .map((asset) =>
      issue('unlicensed-audio', `BGM/SFX「${asset.title}」缺少可发布授权证据。`, {
        assetId: asset.id,
      }),
    )
  blockingIssues.push(...licensedAudioIssues)

  const checklist = quality.checklist || {}
  const humanReviewPassed = Boolean(
    quality.automaticPassed === true &&
      quality.reviewDecision === 'approved' &&
      REVIEW_CHECKS.every((key) => checklist[key] === true),
  )
  const humanReviewEvidencePassed = Boolean(
    humanReviewPassed &&
      hasCompleteAudioHumanEvidence(checklist) &&
      REVIEW_EVIDENCE_CHECKS.every((key) => {
        const evidence = checklist[key] || {}
        return evidence.reviewed === true && String(evidence.note || '').trim()
      }),
  )
  if (!humanReviewPassed) {
    blockingIssues.push(
      issue('human-review-incomplete', '画面、字幕、音频三项人工签核未全部批准。'),
    )
  } else if (!humanReviewEvidencePassed) {
    blockingIssues.push(
      issue('human-review-evidence-incomplete', '人工终审缺少画面、字幕或音频的具体复核证据。'),
    )
  }

  const aiDisclosurePassed = Boolean(
    aiDisclosure.isAiGenerated !== true ||
      (aiDisclosure.disclosureConfirmed === true && String(aiDisclosure.label || '').trim()),
  )
  if (!aiDisclosurePassed) {
    blockingIssues.push(
      issue('ai-disclosure-unconfirmed', 'AI 生成标识尚未确认，发布前必须按平台规则标注。'),
    )
  }

  const platformEvidenceByKey = new Map(
    aiDisclosure.platformEvidence.map((item) => [item.platform, item]),
  )
  const missingPlatformEvidence = input.platforms.filter((platform) => {
    const evidence = platformEvidenceByKey.get(platform)
    return !(
      evidence?.aiLabelReviewed === true &&
      evidence?.copyrightFieldsReviewed === true &&
      String(evidence?.ruleReviewNote || '').trim()
    )
  })
  if (aiDisclosurePassed && missingPlatformEvidence.length > 0) {
    blockingIssues.push(
      issue('platform-evidence-incomplete', '目标平台发布规则核验证据不完整。', {
        platforms: missingPlatformEvidence,
      }),
    )
  }

  if (input.platforms.length) {
    warnings.push(
      issue(
        'platform-rules-recheck-required',
        '红果、抖音等平台规则可能变化，发布当天仍需人工核验官方后台字段、AI 标识和版权要求。',
        { platforms: input.platforms },
      ),
    )
  }

  const canPublish = blockingIssues.length === 0
  const packageData = {
    projectId: input.projectId,
    exportId: input.exportId,
    status: canPublish ? 'release-candidate' : 'blocked',
    canPublish,
    checks: {
      technical: {
        passed: technicalPassed,
        spec: {
          format: exportRecord.format || null,
          resolution: exportRecord.resolution || null,
          frameRate: Number(exportRecord.frameRate) || null,
          videoCodec: exportRecord.videoCodec || null,
          audioCodec: exportRecord.audioCodec || null,
        },
      },
      subtitle: {
        passed: subtitlePassed,
        hasSpeech: subtitle.hasSpeech === true,
        hasValidCues: subtitle.hasValidCues === true,
        burnedIn: subtitle.burnedIn === true,
        cueCount: Number(subtitle.cueCount) || 0,
      },
      audioLicensing: {
        passed: licensedAudioIssues.length === 0,
        assets: input.audioAssets,
      },
      humanReview: {
        passed: humanReviewPassed && humanReviewEvidencePassed,
        automaticPassed: quality.automaticPassed === true,
        reviewDecision: quality.reviewDecision || null,
        checklist: {
          visualReviewed: checklist.visualReviewed === true,
          subtitleReviewed: checklist.subtitleReviewed === true,
          audioReviewed: checklist.audioReviewed === true,
          visualEvidence: {
            reviewed: checklist.visualEvidence?.reviewed === true,
            note: String(checklist.visualEvidence?.note || '').trim() || null,
          },
          subtitleEvidence: {
            reviewed: checklist.subtitleEvidence?.reviewed === true,
            note: String(checklist.subtitleEvidence?.note || '').trim() || null,
          },
          audioEvidence: {
            reviewed: checklist.audioEvidence?.reviewed === true,
            listeningConfirmed: checklist.audioEvidence?.listeningConfirmed === true,
            clarityReviewed: checklist.audioEvidence?.clarityReviewed === true,
            loudnessReviewed: checklist.audioEvidence?.loudnessReviewed === true,
            clippingReviewed: checklist.audioEvidence?.clippingReviewed === true,
            syncReviewed: checklist.audioEvidence?.syncReviewed === true,
            syncNotApplicable: checklist.audioEvidence?.syncNotApplicable === true,
            note: String(checklist.audioEvidence?.note || '').trim() || null,
          },
        },
      },
      platformCompliance: {
        passed: missingPlatformEvidence.length === 0,
        evidence: aiDisclosure.platformEvidence,
        missingPlatforms: missingPlatformEvidence,
      },
    },
    aiDisclosure: {
      isAiGenerated: aiDisclosure.isAiGenerated === true,
      disclosureConfirmed: aiDisclosure.disclosureConfirmed === true,
      label: String(aiDisclosure.label || '').trim() || null,
      platformEvidence: aiDisclosure.platformEvidence,
    },
    platforms: input.platforms,
    blockingIssues,
    warnings,
  }
  const audit = buildReleaseComplianceAudit(packageData)
  const compliancePackage = { ...packageData, audit }
  return {
    ...compliancePackage,
    releaseCandidateSnapshot: buildReleaseCandidateSnapshot(compliancePackage),
  }
}
