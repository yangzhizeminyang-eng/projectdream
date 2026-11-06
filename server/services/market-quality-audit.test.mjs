import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMarketQualityAuditSummary } from './market-quality-audit.mjs'

test('reports insufficient auditable samples without counting missing media as regression passes', () => {
  const summary = buildMarketQualityAuditSummary({
    projectId: 12,
    requiredSampleCount: 10,
    items: [
      {
        exportId: 34,
        status: 'completed',
        storageReadable: true,
        audit: { proxyPassed: false, hardBlockers: [{ code: 'platform-evidence-incomplete' }] },
      },
      {
        exportId: 33,
        status: 'completed',
        storageReadable: true,
        audit: { proxyPassed: false, hardBlockers: [{ code: 'audio-sync-human-required' }] },
      },
      {
        exportId: 27,
        status: 'completed',
        storageReadable: false,
        audit: null,
      },
    ],
  })

  assert.equal(summary.projectId, 12)
  assert.equal(summary.auditableSampleCount, 2)
  assert.equal(summary.missingSampleCount, 8)
  assert.equal(summary.tenSampleReadiness.status, 'blocked')
  assert.equal(summary.tenSampleReadiness.enoughSamples, false)
  assert.deepEqual(summary.storage.missingExportIds, [27])
  assert.equal(summary.proxyPassedCount, 0)
  assert.ok(summary.blockers.some((item) => item.code === 'insufficient-auditable-samples'))
})

test('counts only readable proxy-passed samples and preserves human and platform blockers', () => {
  const summary = buildMarketQualityAuditSummary({
    projectId: 12,
    requiredSampleCount: 2,
    items: [
      {
        exportId: 34,
        status: 'completed',
        storageReadable: true,
        audit: { proxyPassed: true, hardBlockers: [] },
      },
      {
        exportId: 35,
        status: 'completed',
        storageReadable: true,
        audit: {
          proxyPassed: false,
          hardBlockers: [
            { code: 'platform-evidence-incomplete' },
            { code: 'human-listening-required' },
          ],
        },
      },
    ],
  })

  assert.equal(summary.auditableSampleCount, 2)
  assert.equal(summary.proxyPassedCount, 1)
  assert.equal(summary.tenSampleReadiness.status, 'blocked')
  assert.equal(summary.tenSampleReadiness.enoughSamples, true)
  assert.ok(summary.blockers.some((item) => item.code === 'proxy-quality-failed'))
  assert.ok(summary.blockers.some((item) => item.code === 'human-listening-required'))
  assert.equal(summary.blockerCounts['platform-evidence-incomplete'], 1)
})

test('promotes explicit human blockers into the project summary', () => {
  const summary = buildMarketQualityAuditSummary({
    projectId: 12,
    requiredSampleCount: 1,
    items: [
      {
        exportId: 36,
        status: 'completed',
        storageReadable: true,
        audit: {
          proxyPassed: false,
          hardBlockers: [],
          humanBlockers: [
            { code: 'human-listening-required', message: '需要完整播放后人工确认。' },
          ],
        },
      },
    ],
  })

  assert.equal(summary.blockerCounts['human-listening-required'], 1)
  assert.ok(summary.blockers.some((item) => item.code === 'human-listening-required'))
})

test('counts technical proxy passes separately from platform publication readiness', () => {
  const summary = buildMarketQualityAuditSummary({
    projectId: 12,
    requiredSampleCount: 1,
    items: [
      {
        exportId: 35,
        status: 'completed',
        storageReadable: true,
        audit: {
          proxyPassed: false,
          technicalProxyPassed: true,
          hardBlockers: [{ code: 'platform-evidence-incomplete' }],
          humanBlockers: [{ code: 'human-listening-required' }],
        },
      },
    ],
  })

  assert.equal(summary.technicalProxyPassedCount, 1)
  assert.equal(summary.proxyPassedCount, 0)
  assert.equal(summary.tenSampleReadiness.technicallyReady, false)
})
