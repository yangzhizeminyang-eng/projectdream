import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MARKET_QUALITY_BENCHMARK_VERSION,
  evaluateMarketQuality,
  parseSrtCues,
} from './market-quality-benchmark.mjs'

test('parses SRT cues with independent timing and normalized text', () => {
  assert.deepEqual(
    parseSrtCues(
      '1\n00:00:00,000 --> 00:00:00,560\n林夏：……妈？\n\n' +
        '2\n00:00:01,100 --> 00:00:01,660\n苏岚（广播）：五。\n',
    ),
    [
      {
        index: 1,
        startSeconds: 0,
        endSeconds: 0.56,
        text: '林夏：……妈？',
      },
      {
        index: 2,
        startSeconds: 1.1,
        endSeconds: 1.66,
        text: '苏岚（广播）：五。',
      },
    ],
  )
})

test('passes the objective market proxy when hard quality signals are healthy', () => {
  const report = evaluateMarketQuality({
    media: {
      width: 1080,
      height: 1920,
      frameRate: 24,
      audioSampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 5,
    },
    audio: {
      measurable: true,
      integratedLufs: -16,
      truePeakDbtp: -2,
      clippedSamples: 0,
      speechCoverageRatio: 0.24,
    },
    subtitle: {
      cues: parseSrtCues(
        '1\n00:00:00,000 --> 00:00:00,560\n林夏：……妈？\n\n' +
          '2\n00:00:01,100 --> 00:00:01,660\n苏岚（广播）：五。\n',
      ),
      fontSize: 48,
      marginV: 330,
    },
    sync: {
      cueAlignment: [
        { cueIndex: 1, onsetErrorSeconds: 0.03, overlapRatio: 0.96 },
        { cueIndex: 2, onsetErrorSeconds: 0.04, overlapRatio: 0.94 },
      ],
    },
    hook: {
      firstSpeechStartSeconds: 0,
      maxShotDurationSeconds: 5,
    },
    platform: {
      aiDisclosureConfigured: true,
      copyrightEvidenceConfigured: true,
    },
  })

  assert.equal(report.benchmarkVersion, MARKET_QUALITY_BENCHMARK_VERSION)
  assert.equal(report.proxyPassed, true)
  assert.equal(report.hardBlockers.length, 0)
  assert.ok(report.overallScore >= 85)
})

test('blocks a final render whose audio sample rate is not the production 48kHz target', () => {
  const report = evaluateMarketQuality({
    media: {
      width: 1080,
      height: 1920,
      frameRate: 24,
      audioSampleRate: 96000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
      durationSeconds: 5,
    },
    audio: {
      measurable: true,
      integratedLufs: -16,
      truePeakDbtp: -2,
      clippedSamples: 0,
    },
    subtitle: {
      cues: [{ index: 1, startSeconds: 0, endSeconds: 1, text: '字幕' }],
      fontSize: 48,
      marginV: 330,
    },
    sync: { cueAlignment: [{ onsetErrorSeconds: 0.01, overlapRatio: 0.9 }] },
    hook: { firstSpeechStartSeconds: 0, maxShotDurationSeconds: 5 },
    platform: {
      aiDisclosureConfigured: true,
      copyrightEvidenceConfigured: true,
    },
  })

  assert.equal(report.proxyPassed, false)
  assert.ok(report.hardBlockers.some((item) => item.code === 'audio-sample-rate'))
})

test('separates technical machine readiness from later platform evidence', () => {
  const report = evaluateMarketQuality({
    media: {
      width: 1080,
      height: 1920,
      frameRate: 24,
      audioSampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
      durationSeconds: 5,
    },
    audio: {
      measurable: true,
      integratedLufs: -16,
      truePeakDbtp: -2,
      clippedSamples: 0,
    },
    subtitle: {
      cues: [{ index: 1, startSeconds: 0, endSeconds: 1, text: '字幕' }],
      fontSize: 48,
      marginV: 330,
    },
    sync: { cueAlignment: [{ onsetErrorSeconds: 0.01, overlapRatio: 0.9 }] },
    hook: { firstSpeechStartSeconds: 0, maxShotDurationSeconds: 5 },
    platform: {
      aiDisclosureConfigured: false,
      copyrightEvidenceConfigured: false,
    },
  })

  assert.equal(report.technicalProxyPassed, true)
  assert.equal(report.proxyPassed, false)
  assert.ok(report.hardBlockers.some((item) => item.code === 'platform-evidence-incomplete'))
})

test('blocks low loudness, unsafe subtitles, missing sync evidence, and incomplete platform evidence', () => {
  const report = evaluateMarketQuality({
    media: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
      durationSeconds: 5,
    },
    audio: {
      measurable: true,
      integratedLufs: -28,
      truePeakDbtp: -0.2,
      clippedSamples: 4,
      speechCoverageRatio: 0.01,
    },
    subtitle: {
      cues: [{ index: 1, startSeconds: 0, endSeconds: 8, text: '字幕' }],
      fontSize: 22,
      marginV: 50,
    },
    sync: { cueAlignment: [] },
    hook: { firstSpeechStartSeconds: 3, maxShotDurationSeconds: 12 },
    platform: {
      aiDisclosureConfigured: false,
      copyrightEvidenceConfigured: false,
    },
  })

  assert.equal(report.proxyPassed, false)
  assert.ok(report.hardBlockers.some((item) => item.code === 'invalid-vertical-spec'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'audio-too-quiet'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'audio-clipping'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'subtitle-unsafe-area'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'speech-sync-evidence-missing'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'platform-evidence-incomplete'))
})

test('passes the six-dimension machine preflight when objective evidence is complete', () => {
  const report = evaluateMarketQuality({
    media: {
      width: 1080,
      height: 1920,
      frameRate: 24,
      audioSampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
      durationSeconds: 6,
      blackBarDetected: false,
      freezeDetected: false,
      droppedFrameRisk: false,
    },
    audio: {
      measurable: true,
      integratedLufs: -16,
      truePeakDbtp: -2,
      clippedSamples: 0,
      speechCoverageRatio: 0.42,
    },
    subtitle: {
      cues: [
        { index: 1, startSeconds: 0.1, endSeconds: 0.9, text: '林夏：你来了。' },
        { index: 2, startSeconds: 1.4, endSeconds: 2.2, text: '沈砚：我一直在等。' },
      ],
      expectedCues: [
        { startSeconds: 0.1, endSeconds: 0.9, text: '林夏：你来了。' },
        { startSeconds: 1.4, endSeconds: 2.2, text: '沈砚：我一直在等。' },
      ],
      fontSize: 48,
      marginV: 330,
    },
    sync: {
      cueAlignment: [
        { cueIndex: 1, onsetErrorSeconds: 0.03, overlapRatio: 0.96 },
        { cueIndex: 2, onsetErrorSeconds: 0.04, overlapRatio: 0.94 },
      ],
    },
    characters: {
      mode: 'metadata-baseline',
      clips: [
        { storyboardId: 1, characterId: 7, characterVersionNo: 3 },
        { storyboardId: 2, characterId: 7, characterVersionNo: 3 },
      ],
      baselines: [
        {
          characterId: 7,
          versionNo: 3,
          appearance: '黑发、左眉浅疤',
          costume: '深灰长风衣',
          referenceImageUrl: 'https://example.com/shenyan.png',
        },
      ],
    },
    pacing: {
      clips: [
        { durationSeconds: 2, sourceType: 'video' },
        { durationSeconds: 2, sourceType: 'video' },
        { durationSeconds: 2, sourceType: 'static' },
      ],
      totalDurationSeconds: 6,
    },
    hook: {
      firstSpeechStartSeconds: 0.1,
      maxShotDurationSeconds: 2,
    },
    platform: {
      aiDisclosureConfigured: true,
      copyrightEvidenceConfigured: true,
    },
  })

  assert.equal(report.proxyPassed, true)
  assert.equal(report.technicalProxyPassed, true)
  assert.equal(report.dimensions.media.blackBarPassed, true)
  assert.equal(report.dimensions.media.frameIntegrityPassed, true)
  assert.equal(report.dimensions.subtitle.textTimelinePassed, true)
  assert.equal(report.dimensions.characters.passed, true)
  assert.equal(report.dimensions.pacing.passed, true)
  assert.equal(report.hardBlockers.length, 0)
})

test('blocks black bars, freeze risk, subtitle drift, stale character baselines, and weak pacing', () => {
  const report = evaluateMarketQuality({
    media: {
      width: 1080,
      height: 1920,
      frameRate: 24,
      audioSampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
      durationSeconds: 6,
      blackBarDetected: true,
      freezeDetected: true,
      droppedFrameRisk: true,
    },
    audio: {
      measurable: true,
      integratedLufs: -16,
      truePeakDbtp: -2,
      clippedSamples: 0,
      speechCoverageRatio: 0.42,
    },
    subtitle: {
      cues: [{ index: 1, startSeconds: 0, endSeconds: 1, text: '字幕 A' }],
      expectedCues: [{ startSeconds: 0.2, endSeconds: 1.2, text: '字幕 B' }],
      fontSize: 48,
      marginV: 330,
    },
    sync: { cueAlignment: [{ onsetErrorSeconds: 0.01, overlapRatio: 0.9 }] },
    characters: {
      mode: 'metadata-baseline',
      clips: [{ storyboardId: 1, characterId: 7, characterVersionNo: 2 }],
      baselines: [{
        characterId: 7,
        versionNo: 3,
        appearance: '黑发',
        costume: '风衣',
        referenceImageUrl: 'https://example.com/shenyan.png',
      }],
    },
    pacing: {
      clips: [{ durationSeconds: 6, sourceType: 'static' }],
      totalDurationSeconds: 6,
    },
    hook: { firstSpeechStartSeconds: 0.1, maxShotDurationSeconds: 6 },
    platform: { aiDisclosureConfigured: true, copyrightEvidenceConfigured: true },
  })

  assert.ok(report.hardBlockers.some((item) => item.code === 'black-bars-detected'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'freeze-frame-risk'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'dropped-frame-risk'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'subtitle-text-mismatch'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'character-version-mismatch'))
  assert.ok(report.hardBlockers.some((item) => item.code === 'pacing-shot-density-low'))
  assert.equal(report.proxyPassed, false)
})
