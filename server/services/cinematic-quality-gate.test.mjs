import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateCinematicQuality,
  resolveCinematicAudioRenderIssues,
  resolveCinematicInspectionIssues,
} from './cinematic-quality-gate.mjs'

test('promotes required-audio inspection failures to export blockers', () => {
  const issues = resolveCinematicInspectionIssues({
    inspection: {
      technicalStatus: 'needs_attention',
      issues: [
        { code: 'required-audio-near-silent', message: '音频近乎静音', severity: 'warning' },
        { code: 'video-duration-deviation', message: '时长偏差', severity: 'warning' },
      ],
    },
    requiresAudio: true,
  })

  assert.deepEqual(issues.blockers.map((item) => item.code), ['required-audio-near-silent'])
  assert.deepEqual(issues.warnings.map((item) => item.code), ['video-duration-deviation'])
})

test('blocks failed downloads for enabled audio and attaches storyboard-bound audio to its shot', () => {
  const result = resolveCinematicAudioRenderIssues({
    skipped: [
      { audioId: 41, storyboardId: 12, reason: 'HTTP 404' },
      { storyboardId: 13, reason: 'missing-video-and-image' },
    ],
  })

  assert.equal(result.blockers.length, 1)
  assert.equal(result.blockers[0].code, 'enabled-audio-download-failed')
  assert.deepEqual(result.issueShots, [{
    storyboardId: 12,
    code: 'enabled-audio-download-failed',
    message: '分镜 12 的已启用音频无法读取：HTTP 404',
  }])
})

test('blocks completion when rendered media has a blocking issue and keeps issue shots', () => {
  const report = evaluateCinematicQuality({
    plan: { clips: [{ storyboardId: 11 }, { storyboardId: 12 }] },
    sources: [{ storyboardId: 11 }, { storyboardId: 12 }],
    rendered: {
      outputExists: true,
      durationSeconds: 8,
      issueShots: [{ storyboardId: 12, code: 'frozen-frame', message: '镜头疑似冻结' }],
      blockingIssues: [{ code: 'frozen-frame', message: '镜头疑似冻结' }],
    },
  })

  assert.equal(report.passed, false)
  assert.equal(report.blockers[0].code, 'frozen-frame')
  assert.equal(report.issueShots[0].storyboardId, 12)
  assert.ok(report.recommendations.length > 0)
})

test('passes a complete render without silently inventing a warning', () => {
  const report = evaluateCinematicQuality({
    plan: { clips: [{ storyboardId: 11 }] },
    sources: [{ storyboardId: 11 }],
    rendered: { outputExists: true, durationSeconds: 4, blockingIssues: [], issueShots: [] },
  })

  assert.equal(report.passed, true)
  assert.deepEqual(report.blockers, [])
  assert.deepEqual(report.issueShots, [])
})
