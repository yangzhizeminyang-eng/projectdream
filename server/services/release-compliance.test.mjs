import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReleaseComplianceSaveConfirmation,
  buildReleaseCandidateSnapshot,
  buildReleaseCompliancePackage,
  buildReleaseComplianceGapSummary,
  normalizeReleaseComplianceInput,
} from './release-compliance.mjs'

test('blocks a package when licensing, AI disclosure, or review evidence is incomplete', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 14,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 12,
    },
    audioAssets: [
      {
        trackType: 'music',
        title: '悬念 BGM',
        licenseStatus: 'unknown',
        licenseEvidence: '',
      },
    ],
    quality: {
      automaticPassed: true,
      reviewDecision: 'rework',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: false,
        audioReviewed: true,
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: false,
      label: '',
    },
    platforms: ['hongguo', 'douyin'],
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.canPublish, false)
  assert.deepEqual(
    result.blockingIssues.map((issue) => issue.code),
    ['unlicensed-audio', 'human-review-incomplete', 'ai-disclosure-unconfirmed'],
  )
  assert.equal(result.warnings[0].code, 'platform-rules-recheck-required')
})

test('produces an internal release candidate package after all evidence is complete', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 14,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 12,
    },
    audioAssets: [
      {
        trackType: 'music',
        title: '自有 BGM',
        licenseStatus: 'owned',
        licenseEvidence: 'asset-register-001',
      },
      {
        trackType: 'sfx',
        title: '公共领域音效',
        licenseStatus: 'public-domain',
        licenseEvidence: 'public-domain-record-002',
      },
    ],
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
        visualEvidence: {
          reviewed: true,
          note: '画面无拉伸和明显黑边',
        },
        subtitleEvidence: {
          reviewed: true,
          note: '字幕准确且位于安全区',
        },
        audioEvidence: {
          reviewed: true,
          listeningConfirmed: true,
          clarityReviewed: true,
          loudnessReviewed: true,
          clippingReviewed: true,
          syncReviewed: true,
          note: '对白清晰，响度正常',
        },
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
      platformEvidence: [
        {
          platform: 'hongguo',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '已按红果发布页确认 AI 标识和版权字段',
        },
        {
          platform: 'douyin',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '已按抖音发布页确认 AI 标识和版权字段',
        },
      ],
    },
    platforms: ['hongguo', 'douyin'],
  })

  assert.equal(result.status, 'release-candidate')
  assert.equal(result.canPublish, true)
  assert.equal(result.checks.technical.passed, true)
  assert.equal(result.checks.audioLicensing.passed, true)
  assert.equal(result.checks.humanReview.passed, true)
  assert.equal(result.aiDisclosure.label, '本内容包含 AI 生成内容')
})

test('blocks a release candidate when audio evidence lacks actual listening confirmation', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 33,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 1,
    },
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
        visualEvidence: { reviewed: true, note: '画面正常' },
        subtitleEvidence: { reviewed: true, note: '字幕正常' },
        audioEvidence: {
          reviewed: true,
          note: '只确认技术音轨存在，尚未实际播放。',
        },
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
    },
    platforms: [],
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.canPublish, false)
  assert.ok(result.blockingIssues.some((issue) => issue.code === 'human-review-evidence-incomplete'))
})

test('blocks release when target platform evidence is missing', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 31,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 1,
    },
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
        visualEvidence: { reviewed: true, note: '画面正常' },
        subtitleEvidence: { reviewed: true, note: '字幕正常' },
        audioEvidence: { reviewed: true, note: '音频正常' },
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
      platformEvidence: [
        {
          platform: 'hongguo',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '已按红果发布页确认',
        },
      ],
    },
    platforms: ['hongguo', 'douyin'],
  })

  assert.equal(result.status, 'blocked')
  assert.ok(result.blockingIssues.some((issue) => issue.code === 'platform-evidence-incomplete'))
})

test('blocks human approval that only has checkboxes without review evidence notes', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 31,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 1,
    },
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
    },
  })

  assert.equal(result.status, 'blocked')
  assert.ok(result.blockingIssues.some((issue) => issue.code === 'human-review-evidence-incomplete'))
})

test('requires an exact confirmation token before saving release compliance evidence', () => {
  const payload = {
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
      platformEvidence: [
        {
          platform: 'hongguo',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '已按红果发布页确认',
        },
      ],
    },
  }

  assert.throws(
    () => assertReleaseComplianceSaveConfirmation(payload),
    /发布合规确认口令/,
  )
  assert.throws(
    () =>
      assertReleaseComplianceSaveConfirmation({
        ...payload,
        confirm: true,
        confirmationToken: 'CONFIRM',
      }),
    /发布合规确认口令/,
  )

  assert.doesNotThrow(() =>
    assertReleaseComplianceSaveConfirmation({
      ...payload,
      confirm: true,
      confirmationToken: 'CONFIRM_RELEASE_COMPLIANCE_REVIEW',
    }),
  )
})

test('adds a stable audit fingerprint to the release compliance package', () => {
  const baseInput = {
    projectId: 12,
    exportId: 31,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 1,
    },
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
        visualEvidence: { reviewed: true, note: '画面正常' },
        subtitleEvidence: { reviewed: true, note: '字幕正常' },
        audioEvidence: { reviewed: true, note: '音频正常' },
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
      platformEvidence: [
        {
          platform: 'hongguo',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '已按红果发布页确认',
        },
      ],
    },
    platforms: ['hongguo'],
  }
  const first = buildReleaseCompliancePackage(baseInput)
  const second = buildReleaseCompliancePackage(structuredClone(baseInput))
  const changed = buildReleaseCompliancePackage({
    ...baseInput,
    quality: {
      ...baseInput.quality,
      checklist: {
        ...baseInput.quality.checklist,
        audioEvidence: { reviewed: true, note: '音频响度需复查' },
      },
    },
  })

  assert.equal(first.audit.snapshotVersion, 'release-compliance-v1')
  assert.match(first.audit.evidenceHash, /^[a-f0-9]{64}$/)
  assert.equal(first.audit.evidenceHash, second.audit.evidenceHash)
  assert.notEqual(first.audit.evidenceHash, changed.audit.evidenceHash)
})

test('does not build a release candidate snapshot for blocked compliance evidence', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 31,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 1,
    },
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
        visualEvidence: { reviewed: true, note: '画面正常' },
        subtitleEvidence: { reviewed: true, note: '字幕正常' },
        audioEvidence: { reviewed: true, note: '音频正常' },
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
    },
    platforms: ['hongguo'],
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.releaseCandidateSnapshot, null)
  assert.equal(buildReleaseCandidateSnapshot(result), null)
})

test('builds a release candidate snapshot with matching audit evidence hash', () => {
  const result = buildReleaseCompliancePackage({
    projectId: 12,
    exportId: 31,
    exportRecord: {
      status: 'completed',
      videoUrl: 'https://example.com/export.mp4',
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      technicalQualityPassed: true,
    },
    subtitle: {
      hasSpeech: true,
      hasValidCues: true,
      burnedIn: true,
      cueCount: 1,
    },
    audioAssets: [
      {
        trackType: 'music',
        title: '自有 BGM',
        licenseStatus: 'owned',
        licenseEvidence: 'asset-register-001',
      },
    ],
    quality: {
      automaticPassed: true,
      reviewDecision: 'approved',
      checklist: {
        visualReviewed: true,
        subtitleReviewed: true,
        audioReviewed: true,
        visualEvidence: { reviewed: true, note: '画面无拉伸和黑边' },
        subtitleEvidence: { reviewed: true, note: '字幕准确且位于安全区' },
        audioEvidence: {
          reviewed: true,
          listeningConfirmed: true,
          clarityReviewed: true,
          loudnessReviewed: true,
          clippingReviewed: true,
          syncReviewed: true,
          note: '对白清晰，响度正常',
        },
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: true,
      label: '本内容包含 AI 生成内容',
      platformEvidence: [
        {
          platform: 'hongguo',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '已按红果发布页确认 AI 标识和版权字段',
        },
      ],
    },
    platforms: ['hongguo'],
  })
  const snapshot = buildReleaseCandidateSnapshot(result, {
    generatedAt: '2026-09-17T00:00:00.000Z',
  })

  assert.equal(result.status, 'release-candidate')
  assert.equal(result.releaseCandidateSnapshot?.evidenceHash, result.audit.evidenceHash)
  assert.equal(snapshot.snapshotVersion, 'release-candidate-snapshot-v1')
  assert.equal(snapshot.generatedAt, '2026-09-17T00:00:00.000Z')
  assert.equal(snapshot.projectId, 12)
  assert.equal(snapshot.exportId, 31)
  assert.equal(snapshot.evidenceHash, result.audit.evidenceHash)
  assert.deepEqual(snapshot.platforms, ['hongguo'])
  assert.equal(snapshot.technicalSpec.resolution, '1080 x 1920 (vertical)')
  assert.equal(snapshot.technicalSpec.frameRate, 24)
  assert.equal(snapshot.aiDisclosure.label, '本内容包含 AI 生成内容')
  assert.equal(snapshot.aiDisclosure.platformEvidence[0].platform, 'hongguo')
  assert.equal(snapshot.humanReviewEvidence.audioChecklist.listeningConfirmed, true)
  assert.equal(snapshot.humanReviewEvidence.audioChecklist.clarityReviewed, true)
  assert.equal(snapshot.humanReviewEvidence.audioChecklist.loudnessReviewed, true)
  assert.equal(snapshot.humanReviewEvidence.audioChecklist.clippingReviewed, true)
  assert.equal(snapshot.humanReviewEvidence.audioChecklist.syncReviewed, true)
  assert.equal(snapshot.humanReviewEvidence.audioChecklist.syncNotApplicable, false)
})

test('normalizes the compliance input and rejects unknown licensing states', () => {
  assert.throws(
    () =>
      normalizeReleaseComplianceInput({
        exportRecord: { status: 'completed' },
        audioAssets: [{ trackType: 'music', licenseStatus: 'maybe' }],
      }),
    /授权状态无效/,
  )
})

test('summarizes release compliance gaps without changing or approving evidence', () => {
  const result = buildReleaseComplianceGapSummary({
    status: 'blocked',
    canPublish: false,
    blockingIssues: [
      { code: 'human-review-incomplete', message: '缺少人工复核' },
      { code: 'platform-evidence-incomplete', message: '缺少平台证据', platforms: ['hongguo', 'douyin'] },
    ],
    checks: {
      humanReview: {
        passed: false,
        reviewDecision: null,
      },
      platformCompliance: {
        passed: false,
        missingPlatforms: ['hongguo', 'douyin'],
      },
    },
    aiDisclosure: {
      isAiGenerated: true,
      disclosureConfirmed: false,
      label: null,
      platformEvidence: [],
    },
    platforms: ['hongguo', 'douyin'],
    audit: { evidenceHash: 'abc123' },
  })

  assert.deepEqual(result, {
    status: 'blocked',
    canPublish: false,
    evidenceHash: 'abc123',
    blockingIssueCodes: ['human-review-incomplete', 'platform-evidence-incomplete'],
    missingPlatforms: ['hongguo', 'douyin'],
    aiDisclosureConfirmed: false,
    aiDisclosureLabel: null,
    humanReviewPassed: false,
    reviewDecision: null,
    platformEvidenceCount: 0,
    disclaimer: '只读缺口摘要，不代表平台审核通过，也不会自动写入或批准任何证据。',
  })
})
