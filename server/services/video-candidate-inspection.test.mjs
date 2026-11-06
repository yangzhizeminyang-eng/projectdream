import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildVideoCandidateInspection,
  inferVideoCandidateExpectations,
} from './video-candidate-inspection.mjs'

test('derives motion and sound expectations from the shot instead of assuming every video needs both', () => {
  const expectations = inferVideoCandidateExpectations({
    durationSeconds: 5,
    actionText: '发卡从传送窗口滑出，林知夏抬头望向走廊。',
    dialogueText: '（无对白）',
    audioDirection: '环境声：打印机走纸、台灯电流、远处通风低鸣。',
    gazePlan: { transitions: [{ target: '@红色发卡' }, { target: '@绿色安全出口灯' }] },
    soundPlan: { bed: '连续空间底噪', cues: [{ sound: '窗口滑动声' }] },
  })

  assert.deepEqual(expectations, {
    durationSeconds: 5,
    requiresMotion: true,
    requiresAudio: true,
    requiresGazeReview: true,
    gazeTargetCount: 2,
    requiresContinuousAmbience: true,
    soundCueCount: 1,
  })
})

test('derives motion and sound expectations from the submitted prompt override', () => {
  const expectations = inferVideoCandidateExpectations({
    durationSeconds: 8,
    actionText: '时间轴：2-5秒红色发卡沿传送窗口滑出台面。',
    audioDirection: '声音：窗口机械滑动声、打印机走纸轻响。',
  })

  assert.deepEqual(expectations, {
    durationSeconds: 8,
    requiresMotion: true,
    requiresAudio: true,
    requiresGazeReview: false,
    gazeTargetCount: 0,
    requiresContinuousAmbience: false,
    soundCueCount: 0,
  })
})

test('flags near-silent audio when the shot explicitly requires sound', () => {
  const report = buildVideoCandidateInspection({
    expected: {
      durationSeconds: 5,
      requiresAudio: true,
      requiresMotion: true,
      requiresGazeReview: true,
      gazeTargetCount: 2,
      requiresContinuousAmbience: true,
      soundCueCount: 1,
    },
    media: { width: 768, height: 1344, durationSeconds: 5.17, frameRate: 24, audioCodec: 'aac' },
    motion: { frozenDurationSeconds: 4.2 },
    audio: { streamPresent: true, meanVolumeDb: -51.5, silenceRatio: 0.8 },
  })

  assert.equal(report.technicalStatus, 'needs_attention')
  assert.ok(report.issues.some((item) => item.code === 'required-audio-near-silent'))
  assert.ok(report.issues.some((item) => item.code === 'expected-motion-freeze-risk'))
  assert.equal(report.semanticStatus, 'pending_review')
  assert.match(report.reviewRequirements.gaze, /2个视线目标/u)
  assert.match(report.reviewRequirements.sound, /1个动作拟音/u)
})

test('flags near-static motion from measured frame differences even when no long freeze is detected', () => {
  const report = buildVideoCandidateInspection({
    expected: { durationSeconds: 5, requiresMotion: true, requiresAudio: false },
    media: { width: 768, height: 1344, durationSeconds: 5.167, frameRate: 24 },
    motion: { frozenDurationSeconds: 0.83, meanFrameDifference: 0.34, maxFrameDifference: 0.91 },
  })

  assert.equal(report.technicalStatus, 'needs_attention')
  assert.ok(report.issues.some((item) => item.code === 'expected-motion-near-static'))
  assert.equal(report.metrics.meanFrameDifference, 0.34)
})

test('flags motion concentrated in a few frames even when its average difference looks healthy', () => {
  const report = buildVideoCandidateInspection({
    expected: { durationSeconds: 5, requiresMotion: true, requiresAudio: false },
    media: { width: 768, height: 1344, durationSeconds: 5, frameRate: 24 },
    motion: {
      frozenDurationSeconds: 0,
      meanFrameDifference: 2.4,
      maxFrameDifference: 42,
      activeFrameRatio: 0.025,
    },
  })

  assert.equal(report.technicalStatus, 'needs_attention')
  assert.equal(report.metrics.activeFrameRatio, 0.025)
  assert.ok(report.issues.some((item) => item.code === 'expected-motion-low-coverage'))
})

test('does not flag intentional silent reaction shots for missing audio or motion', () => {
  const report = buildVideoCandidateInspection({
    expected: { durationSeconds: 4, requiresAudio: false, requiresMotion: false },
    media: { width: 1080, height: 1920, durationSeconds: 4, frameRate: 24 },
    motion: { frozenDurationSeconds: 3.8 },
    audio: { streamPresent: false, meanVolumeDb: null, silenceRatio: 1 },
  })

  assert.equal(report.technicalStatus, 'passed')
  assert.equal(report.issues.length, 0)
  assert.equal(report.semanticStatus, 'pending_review')
})

test('reports missing measurements as unchecked instead of passing them', () => {
  const report = buildVideoCandidateInspection({
    expected: { durationSeconds: 5, requiresAudio: true, requiresMotion: true },
    media: {},
    motion: null,
    audio: null,
  })

  assert.equal(report.technicalStatus, 'unchecked')
  assert.equal(report.semanticStatus, 'pending_review')
  assert.match(report.summary, /未完成/u)
})
