import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFailedExportConfig,
  resolveSpeechRenderPolicy,
  resolveSpeechSyncOffsetSeconds,
  shouldBlockSubtitleFallback,
  shouldPreserveSpeechTiming,
} from './final-edit-render-policy.mjs'

test('blocks silent subtitle fallback when subtitle burn-in is required', () => {
  assert.equal(
    shouldBlockSubtitleFallback({
      burnSubtitle: true,
      subtitleText: '林夏：……妈？',
      renderFailed: true,
    }),
    true,
  )
})

test('allows the original render error when subtitles are disabled or empty', () => {
  assert.equal(
    shouldBlockSubtitleFallback({
      burnSubtitle: false,
      subtitleText: '林夏：……妈？',
      renderFailed: true,
    }),
    false,
  )
  assert.equal(
    shouldBlockSubtitleFallback({
      burnSubtitle: true,
      subtitleText: '',
      renderFailed: true,
    }),
    false,
  )
})

test('does not speed up short speech just because the video clip is longer', () => {
  assert.equal(
    shouldPreserveSpeechTiming({
      sourceDurationSeconds: 0.56,
      availableDurationSeconds: 5,
    }),
    true,
  )
})

test('blocks dialogue that cannot fit the shot instead of speeding it up', () => {
  assert.deepEqual(
    resolveSpeechRenderPolicy({
      trackKey: 'dialogue',
      sourceDurationSeconds: 4.2,
      availableDurationSeconds: 3.5,
    }),
    {
      passed: false,
      shouldCompress: false,
      reason: 'speech-duration-exceeds-shot',
      overflowSeconds: 0.7,
    },
  )
})

test('keeps non-speech compression available for music and effects', () => {
  assert.deepEqual(
    resolveSpeechRenderPolicy({
      trackKey: 'music',
      sourceDurationSeconds: 4.2,
      availableDurationSeconds: 3.5,
    }),
    {
      passed: true,
      shouldCompress: true,
      reason: 'non-speech-track',
      overflowSeconds: 0.7,
    },
  )
})

test('keeps lip-sync dialogue source-locked by default', () => {
  assert.equal(
    resolveSpeechSyncOffsetSeconds({ sourceType: 'lip_sync' }),
    0,
  )
  assert.equal(
    resolveSpeechSyncOffsetSeconds({ sourceType: 'generated_video' }),
    0,
  )
})

test('clamps an explicitly configured speech sync compensation', () => {
  assert.equal(
    resolveSpeechSyncOffsetSeconds({
      sourceType: 'lip_sync',
      configuredOffsetSeconds: 1.2,
    }),
    0.8,
  )
})

test('replaces stale successful technical evidence when an export fails', () => {
  const result = buildFailedExportConfig(
    {
      pipeline: 'single-video-final-edit-v1',
      subtitleFile: 'http://example.test/exports/44/subtitles.srt',
      subtitleStorageKey: 'projects/12/exports/44/subtitles.srt',
      subtitleBurnedIn: true,
      technicalQuality: {
        status: 'passed',
        blockingIssues: [],
        inspectedMedia: { width: 1080, height: 1920 },
      },
    },
    {
      message: '最终 MP4 未检测到字幕像素',
      code: 'subtitle-pixels-not-detected',
    },
  )

  assert.equal(result.pipeline, 'single-video-final-edit-v1')
  assert.equal(result.subtitleFile, null)
  assert.equal(result.subtitleStorageKey, null)
  assert.equal(result.subtitleBurnedIn, false)
  assert.equal(result.technicalQuality.status, 'failed')
  assert.equal(result.technicalQuality.automaticPassed, false)
  assert.deepEqual(result.technicalQuality.inspectedMedia, null)
  assert.equal(result.technicalQuality.blockingIssues[0].code, 'subtitle-pixels-not-detected')
})
