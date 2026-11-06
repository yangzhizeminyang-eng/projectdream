import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProductionReadinessReport,
  buildStorageOperationsReadiness,
} from './production-readiness.mjs'

function readyRegression() {
  return {
    productionReadiness: { ready: true, blockers: [], passedSampleCount: 10 },
    summary: {
      requiredSampleCount: 10,
      sampleCount: 10,
      automaticPassedCount: 10,
      approvedCount: 10,
      reviewEvidenceGapCount: 0,
    },
    coverage: { missingBuckets: [] },
  }
}

function readyMarketAudit() {
  return {
    summary: {
      storage: { missingCount: 0, missingExportIds: [] },
      blockerCounts: {},
      tenSampleReadiness: {
        technicalMachineReady: true,
        technicallyReady: true,
        auditableSampleCount: 10,
        technicalProxyPassedCount: 10,
        proxyPassedCount: 10,
      },
    },
  }
}

function readyReleaseCompliance() {
  return {
    canPublish: true,
    status: 'release-candidate',
    blockingIssues: [],
    aiDisclosure: {
      disclosureConfirmed: true,
      label: '本视频由 AI 辅助生成',
      platformEvidence: [
        {
          platform: 'hongguo',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '红果字段已核对',
        },
        {
          platform: 'douyin',
          aiLabelReviewed: true,
          copyrightFieldsReviewed: true,
          ruleReviewNote: '抖音字段已核对',
        },
      ],
    },
    checks: { platformCompliance: { missingPlatforms: [] } },
  }
}

test('keeps production readiness blocked and names every missing money-path gate', () => {
  const report = buildProductionReadinessReport({
    projectId: 12,
    finalQualityRegression: {
      productionReadiness: {
        ready: false,
        blockers: [
          { code: 'technical-pass-incomplete', message: '技术通过样本不足' },
          { code: 'human-review-evidence-incomplete', message: '人工证据缺口' },
        ],
      },
      summary: {
        requiredSampleCount: 10,
        sampleCount: 2,
        automaticPassedCount: 1,
        approvedCount: 0,
        reviewEvidenceGapCount: 7,
      },
      coverage: {
        missingBuckets: [
          { key: 'single-character', label: '单人镜头' },
          { key: 'action', label: '动作镜头' },
        ],
      },
    },
    marketQualityAudit: {
      summary: {
        storage: { missingCount: 8, missingExportIds: [20, 21, 22, 23, 24, 25, 26, 27] },
        blockerCounts: {
          'subtitle-text-mismatch': 1,
          'subtitle-timeline-drift': 1,
          'character-version-evidence-missing': 1,
        },
        tenSampleReadiness: {
          technicalMachineReady: false,
          auditableSampleCount: 10,
          technicalProxyPassedCount: 1,
          proxyPassedCount: 0,
        },
      },
    },
    releaseCompliance: {
      canPublish: false,
      blockingIssues: [
        { code: 'human-review-incomplete', message: '人工终审未完成' },
        { code: 'platform-evidence-incomplete', message: '平台证据不完整' },
      ],
      checks: { platformCompliance: { missingPlatforms: ['hongguo', 'douyin'] } },
      aiDisclosure: { disclosureConfirmed: false, platformEvidence: [] },
    },
    costLedger: {
      pricingCatalogConfigured: false,
      summary: { entryCount: 4, unpricedEntryCount: 2 },
    },
    storageOperations: {
      objectStorage: { provider: 'cos', ready: true, missing: [] },
      cdn: { ready: false },
      backup: { ready: false },
      crossMachineRestore: { ready: false },
    },
    platformValidation: {
      publishedEpisodeCount: 0,
      metricsImported: false,
      revenueRecorded: false,
    },
  })

  assert.equal(report.status, 'blocked')
  assert.equal(report.releaseCandidateReady, false)
  assert.equal(report.stableRevenueReady, false)
  assert.deepEqual(
    report.blockers.map((item) => item.code),
    [
      'regression-production-not-ready',
      'regression-coverage-incomplete',
      'missing-media-objects',
      'subtitle-audit-failed',
      'character-version-evidence-missing',
      'market-machine-quality-not-ready',
      'release-compliance-blocked',
      'platform-evidence-incomplete',
      'cdn-not-configured',
      'backup-not-verified',
      'cross-machine-restore-not-verified',
      'cost-pricing-incomplete',
      'platform-publication-data-missing',
      'platform-metrics-missing',
      'revenue-evidence-missing',
    ],
  )
  assert.equal(report.actionQueue[0].code, 'complete-ten-final-edit-regression')
  assert.equal(report.actionQueue.some((item) => item.code === 'repair-missing-media'), true)
  assert.equal(report.stages.finalEditRegression.passed, false)
  assert.equal(report.stages.storageOperations.passed, false)
})

test('marks controlled publishing ready only when technical, compliance, ops, and cost gates pass', () => {
  const report = buildProductionReadinessReport({
    projectId: 12,
    finalQualityRegression: readyRegression(),
    marketQualityAudit: readyMarketAudit(),
    releaseCompliance: readyReleaseCompliance(),
    costLedger: {
      pricingCatalogConfigured: true,
      summary: { entryCount: 12, unpricedEntryCount: 0 },
    },
    storageOperations: {
      objectStorage: { provider: 'cos', ready: true, missing: [] },
      cdn: { ready: true },
      backup: { ready: true },
      crossMachineRestore: { ready: true },
    },
    platformValidation: {
      publishedEpisodeCount: 0,
      metricsImported: false,
      revenueRecorded: false,
    },
  })

  assert.equal(report.status, 'ready-for-controlled-publish')
  assert.equal(report.releaseCandidateReady, true)
  assert.equal(report.stableRevenueReady, false)
  assert.equal(report.stages.platformValidation.passed, false)
  assert.deepEqual(
    report.blockers.map((item) => item.code),
    [
      'platform-publication-data-missing',
      'platform-metrics-missing',
      'revenue-evidence-missing',
    ],
  )
})

test('marks stable revenue ready only with real platform and revenue evidence', () => {
  const report = buildProductionReadinessReport({
    projectId: 12,
    finalQualityRegression: readyRegression(),
    marketQualityAudit: readyMarketAudit(),
    releaseCompliance: readyReleaseCompliance(),
    costLedger: {
      pricingCatalogConfigured: true,
      summary: { entryCount: 12, unpricedEntryCount: 0 },
    },
    storageOperations: {
      objectStorage: { provider: 'cos', ready: true, missing: [] },
      cdn: { ready: true },
      backup: { ready: true },
      crossMachineRestore: { ready: true },
    },
    platformValidation: {
      publishedEpisodeCount: 3,
      metricsImported: true,
      revenueRecorded: true,
    },
  })

  assert.equal(report.status, 'stable-revenue-evidence-ready')
  assert.equal(report.releaseCandidateReady, true)
  assert.equal(report.stableRevenueReady, true)
  assert.deepEqual(report.blockers, [])
})

test('builds storage operations readiness from environment without exposing secrets', () => {
  const readiness = buildStorageOperationsReadiness({
    OBJECT_STORAGE_PROVIDER: 'cos',
    COS_SECRET_ID: 'id',
    COS_SECRET_KEY: 'secret',
    COS_BUCKET: 'bucket',
    COS_REGION: 'ap-guangzhou',
    OBJECT_STORAGE_PUBLIC_BASE_URL: 'https://cdn.example.com',
    OBJECT_STORAGE_BACKUP_ENABLED: 'true',
    OBJECT_STORAGE_BACKUP_LAST_VERIFIED_AT: '2026-09-18T00:00:00.000Z',
    CROSS_MACHINE_RESTORE_LAST_VERIFIED_AT: '2026-09-18T00:00:00.000Z',
  })

  assert.equal(readiness.objectStorage.ready, true)
  assert.equal(readiness.cdn.ready, true)
  assert.equal(readiness.backup.ready, true)
  assert.equal(readiness.crossMachineRestore.ready, true)
  assert.equal(JSON.stringify(readiness).includes('secret'), false)
})
