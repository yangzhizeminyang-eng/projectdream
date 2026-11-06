import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFinalQualityRegressionReport,
  normalizeFinalQualityRegressionTagUpdate,
} from './final-quality-regression.mjs'

function exportSample(id, overrides = {}) {
  return {
    id,
    status: 'completed',
    durationSeconds: 5,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:02:00.000Z',
    config: {
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      regressionTags: ['empty-scene'],
      technicalQuality: {
        status: 'passed',
        inspectedMedia: {
          width: 1080,
          height: 1920,
          frameRate: 24,
          audioSignal: 'measurable',
        },
        blockingIssues: [],
      },
    },
    ...overrides,
  }
}

function approvedReport(exportId) {
  return {
    exportId,
    automaticPassed: true,
    reviewDecision: 'approved',
    releaseStatus: 'release-candidate',
    reviewChecklist: {
      visualReviewed: true,
      subtitleReviewed: true,
      audioReviewed: true,
      characterConsistencyReviewed: true,
      visualEvidence: { reviewed: true, note: '画面正常' },
      subtitleEvidence: { reviewed: true, note: '字幕正常' },
      audioEvidence: {
        reviewed: true,
        listeningConfirmed: true,
        clarityReviewed: true,
        loudnessReviewed: true,
        clippingReviewed: true,
        syncReviewed: true,
        note: '音频正常',
      },
      characterConsistencyEvidence: {
        reviewed: true,
        note: '人物一致性正常',
      },
    },
  }
}

test('blocks the final quality regression report until ten samples exist', () => {
  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports: [exportSample(31)],
    qualityReports: [approvedReport(31)],
    costEntries: [{ exportId: 31, estimatedCost: 0.2, currency: 'CNY', pricingStatus: 'estimated' }],
  })

  assert.equal(report.status, 'insufficient-samples')
  assert.equal(report.ready, false)
  assert.equal(report.summary.sampleCount, 1)
  assert.equal(report.summary.requiredSampleCount, 10)
  assert.equal(report.summary.missingSampleCount, 9)
  assert.equal(report.blockers[0].code, 'insufficient-regression-samples')
})

test('excludes canceled and unfinished exports while keeping older real attempts in the regression sample', () => {
  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports: [
      exportSample(33, { status: 'canceled' }),
      exportSample(32, { status: 'queued' }),
      exportSample(31, { status: 'completed' }),
    ],
    qualityReports: [approvedReport(31)],
    requiredSampleCount: 1,
  })

  assert.equal(report.summary.sampleCount, 1)
  assert.equal(report.items[0].exportId, 31)
  assert.equal(report.sampleScope.excludedCount, 2)
  assert.deepEqual(report.sampleScope.includedStatuses, ['completed', 'failed'])
  assert.deepEqual(report.sampleScope.excludedStatuses, ['canceled', 'queued', 'running'])
})

test('preserves the database exclusion count when the export query already filtered statuses', () => {
  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports: [exportSample(31)],
    qualityReports: [approvedReport(31)],
    excludedExportCount: 87,
  })

  assert.equal(report.summary.sampleCount, 1)
  assert.equal(report.sampleScope.excludedCount, 87)
})

test('summarizes ten controlled final quality samples without executing production work', () => {
  const exports = Array.from({ length: 10 }, (_, index) => exportSample(index + 1))
  exports[0].config.regressionTags = ['empty-scene']
  exports[1].config.regressionTags = ['single-character', 'dialogue']
  exports[2].config.regressionTags = ['two-character', 'dialogue']
  exports[3].config.regressionTags = ['narration']
  exports[4].config.regressionTags = ['action']
  exports[8] = exportSample(9, { status: 'failed' })
  const qualityReports = exports.slice(0, 8).map((item) => approvedReport(item.id))
  qualityReports.push({
    exportId: 9,
    automaticPassed: false,
    reviewDecision: null,
    releaseStatus: 'blocked',
    automaticReport: {
      blockingIssues: [{ code: 'render-failed', message: '终剪失败' }],
    },
  })
  qualityReports.push({
    exportId: 10,
    automaticPassed: true,
    reviewDecision: 'rework',
    releaseStatus: 'pending-review',
    reviewNote: '字幕压住人物脸部',
    reviewChecklist: {
      visualReviewed: true,
      subtitleReviewed: false,
      audioReviewed: true,
    },
  })

  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports,
    qualityReports,
    costEntries: exports.map((item) => ({
      exportId: item.id,
      estimatedCost: 0.2,
      currency: 'CNY',
      pricingStatus: 'estimated',
    })),
  })

  assert.equal(report.status, 'ready')
  assert.equal(report.ready, true)
  assert.equal(report.coverage.coveredCount, 6)
  assert.equal(report.coverage.missingBuckets.length, 0)
  assert.equal(report.summary.sampleCount, 10)
  assert.equal(report.summary.completedCount, 9)
  assert.equal(report.summary.automaticPassedCount, 9)
  assert.equal(report.summary.approvedCount, 8)
  assert.equal(report.summary.reworkCount, 1)
  assert.equal(report.summary.failedCount, 1)
  assert.equal(report.summary.approvalRate, 0.8)
  assert.equal(report.summary.averageTurnaroundSeconds, 120)
  assert.deepEqual(report.cost.totalEstimatedCostByCurrency, { CNY: 2 })
  assert.deepEqual(report.cost.averageEstimatedCostByCurrency, { CNY: 0.2 })
  assert.equal(report.reworkReasons[0].message, '字幕压住人物脸部')
  assert.equal(report.reworkReasons[1].message, '终剪失败')
  assert.equal(report.items[9].qualityGapCodes.includes('human-rework'), true)
  assert.equal(report.productionReadiness.ready, false)
  assert.equal(report.productionReadiness.status, 'blocked')
  assert.equal(
    report.productionReadiness.blockers.some((item) => item.code === 'technical-pass-incomplete'),
    true,
  )
  assert.equal(
    report.productionReadiness.blockers.some((item) => item.code === 'human-approval-incomplete'),
    true,
  )
})

test('keeps ten samples blocked when required regression coverage is incomplete', () => {
  const exports = Array.from({ length: 10 }, (_, index) =>
    exportSample(index + 1, {
      config: {
        ...exportSample(index + 1).config,
        regressionTags: ['single-character', 'dialogue'],
      },
    }),
  )

  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports,
    qualityReports: exports.map((item) => approvedReport(item.id)),
    costEntries: [],
  })

  assert.equal(report.status, 'coverage-incomplete')
  assert.equal(report.ready, false)
  assert.equal(report.coverage.requiredCount, 6)
  assert.equal(report.coverage.coveredCount, 2)
  assert.deepEqual(
    report.coverage.missingBuckets.map((item) => item.key),
    ['empty-scene', 'two-character', 'narration', 'action'],
  )
  assert.equal(report.blockers[0].code, 'regression-coverage-incomplete')
})

test('assigns the next manual action for each final quality regression sample', () => {
  const exports = [
    exportSample(1, { status: 'failed' }),
    exportSample(2, {
      config: {
        ...exportSample(2).config,
        regressionTags: [],
      },
    }),
    exportSample(3),
    exportSample(4),
    exportSample(5),
  ]
  const qualityReports = [
    approvedReport(2),
    {
      ...approvedReport(3),
      reviewDecision: null,
      releaseStatus: 'pending-review',
    },
    {
      ...approvedReport(4),
      reviewDecision: 'rework',
      releaseStatus: 'pending-review',
      reviewNote: '字幕遮挡主体',
    },
    approvedReport(5),
  ]

  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports,
    qualityReports,
    costEntries: [],
    requiredSampleCount: 5,
  })

  assert.equal(report.items[0].nextAction.code, 'resolve-technical-blocker')
  assert.equal(report.items[1].nextAction.code, 'add-coverage-tags')
  assert.equal(report.items[2].nextAction.code, 'complete-human-review')
  assert.equal(report.items[3].nextAction.code, 'resolve-human-rework')
  assert.equal(report.items[4].nextAction.code, 'regression-sample-ready')
})

test('lists the missing human review evidence for each regression sample', () => {
  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports: [exportSample(1), exportSample(2), exportSample(3)],
    qualityReports: [
      {
        ...approvedReport(1),
        reviewChecklist: {
          visualReviewed: true,
          subtitleReviewed: false,
          audioReviewed: true,
          characterConsistencyReviewed: false,
          visualEvidence: { reviewed: true, note: '画面正常' },
          subtitleEvidence: { reviewed: false, note: '' },
          audioEvidence: {
            reviewed: true,
            listeningConfirmed: true,
            clarityReviewed: true,
            loudnessReviewed: true,
            clippingReviewed: true,
            syncReviewed: true,
            note: '音频正常',
          },
        },
      },
      {
        ...approvedReport(2),
        reviewDecision: null,
        reviewChecklist: {
          visualReviewed: false,
          subtitleReviewed: false,
          audioReviewed: false,
          characterConsistencyReviewed: false,
        },
      },
    ],
    requiredSampleCount: 3,
  })

  assert.deepEqual(
    report.items[0].reviewEvidenceGaps.map((item) => item.code),
    ['subtitle-evidence-missing', 'character-consistency-evidence-missing'],
  )
  assert.deepEqual(
    report.items[1].reviewEvidenceGaps.map((item) => item.code),
    [
      'human-review-decision-missing',
      'visual-evidence-missing',
      'subtitle-evidence-missing',
      'audio-evidence-missing',
      'character-consistency-evidence-missing',
    ],
  )
  assert.equal(report.items[2].reviewEvidenceGaps.length, 5)
  assert.equal(report.summary.reviewEvidenceGapCount, 12)
  assert.equal(report.reviewEvidence.totalGapCount, 12)
  assert.deepEqual(
    report.reviewEvidence.buckets.map((item) => [item.code, item.count]),
    [
      ['human-review-decision-missing', 2],
      ['visual-evidence-missing', 2],
      ['subtitle-evidence-missing', 3],
      ['audio-evidence-missing', 2],
      ['character-consistency-evidence-missing', 3],
    ],
  )
  assert.equal(report.productionReadiness.blockers.some((item) => item.code === 'human-review-evidence-incomplete'), true)
})

test('keeps regression evidence blocked when audio has only a generic note', () => {
  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports: [exportSample(1)],
    qualityReports: [
      {
        ...approvedReport(1),
        reviewChecklist: {
          ...approvedReport(1).reviewChecklist,
          audioEvidence: {
            reviewed: true,
            note: '只确认技术音轨存在，尚未完成实际听感复核。',
          },
        },
      },
    ],
    requiredSampleCount: 1,
  })

  assert.deepEqual(report.items[0].reviewEvidenceGaps.map((item) => item.code), [
    'audio-evidence-missing',
  ])
  assert.equal(report.productionReadiness.ready, false)
  assert.equal(report.summary.reviewEvidenceGapCount, 1)
})

test('does not report a character evidence gap when the shot explicitly has no visible people', () => {
  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports: [exportSample(1)],
    qualityReports: [
      {
        ...approvedReport(1),
        reviewChecklist: {
          visualReviewed: true,
          subtitleReviewed: true,
          audioReviewed: true,
          characterConsistencyReviewed: false,
          characterConsistencyNotApplicable: true,
          visualEvidence: { reviewed: true, note: '广播机画面正常' },
          subtitleEvidence: { reviewed: true, note: '字幕在安全区' },
          audioEvidence: {
            reviewed: true,
            listeningConfirmed: true,
            clarityReviewed: true,
            loudnessReviewed: true,
            clippingReviewed: true,
            syncReviewed: true,
            note: '记录了可验证的音轨事实',
          },
          characterConsistencyEvidence: {
            reviewed: false,
            notApplicable: true,
            note: '不适用：当前镜头没有实体人物。',
          },
        },
      },
    ],
    requiredSampleCount: 1,
  })

  assert.deepEqual(report.items[0].reviewEvidenceGaps, [])
  assert.equal(report.summary.characterConsistencyGapCount, 0)
})

test('marks production readiness only when all regression samples pass technical and human gates', () => {
  const exports = Array.from({ length: 10 }, (_, index) => exportSample(index + 1))
  exports[0].config.regressionTags = ['empty-scene']
  exports[1].config.regressionTags = ['single-character', 'dialogue']
  exports[2].config.regressionTags = ['two-character', 'dialogue']
  exports[3].config.regressionTags = ['narration']
  exports[4].config.regressionTags = ['action']

  const report = buildFinalQualityRegressionReport({
    projectId: 12,
    exports,
    qualityReports: exports.map((item) => approvedReport(item.id)),
    costEntries: [],
  })

  assert.equal(report.status, 'ready')
  assert.equal(report.productionReadiness.ready, true)
  assert.equal(report.productionReadiness.status, 'ready')
  assert.equal(report.productionReadiness.passedSampleCount, 10)
  assert.equal(report.productionReadiness.requiredPassedSampleCount, 10)
  assert.deepEqual(report.productionReadiness.blockers, [])
})

test('requires explicit confirmation before saving final quality regression tags', () => {
  const payload = {
    tags: ['empty', 'single_character', 'dialogue', 'unknown'],
    note: '覆盖空镜头、单人对白样本',
  }

  assert.throws(
    () => normalizeFinalQualityRegressionTagUpdate(payload),
    /终剪回归标签确认口令/,
  )

  const result = normalizeFinalQualityRegressionTagUpdate({
    ...payload,
    confirm: true,
    confirmationToken: 'CONFIRM_FINAL_QUALITY_REGRESSION_TAGS',
  })

  assert.deepEqual(result.tags, ['empty-scene', 'single-character', 'dialogue'])
  assert.equal(result.note, '覆盖空镜头、单人对白样本')
})
