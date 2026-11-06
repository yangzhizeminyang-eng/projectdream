import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateSpeechAudioSourceReadiness } from './speech-audio-readiness.mjs'

test('blocks a required storyboard dialogue source that could not be downloaded', () => {
  const result = evaluateSpeechAudioSourceReadiness({
    checks: [
      {
        audioId: 120,
        storyboardId: 180,
        trackType: 'dialogue',
        title: '对白轨 · 03 - 苏岚',
        status: 'download-failed',
        reason: 'media download failed with HTTP 404',
      },
    ],
  })

  assert.deepEqual(result, {
    passed: false,
    blockingIssues: [
      {
        code: 'speech-audio-download-failed',
        audioId: 120,
        storyboardId: 180,
        message: '对白「对白轨 · 03 - 苏岚」无法读取：media download failed with HTTP 404。',
      },
    ],
  })
})

test('blocks a required narration source without a measurable audio signal', () => {
  const result = evaluateSpeechAudioSourceReadiness({
    checks: [
      {
        audioId: 32,
        storyboardId: 180,
        trackType: 'narration',
        title: '开场旁白',
        status: 'silent',
      },
    ],
  })

  assert.deepEqual(result.blockingIssues, [
    {
      code: 'speech-audio-silent',
      audioId: 32,
      storyboardId: 180,
      message: '旁白「开场旁白」检测为静音，不能进入正式终剪。',
    },
  ])
})

test('accepts only measurable required speech sources', () => {
  const result = evaluateSpeechAudioSourceReadiness({
    checks: [
      {
        audioId: 120,
        storyboardId: 180,
        trackType: 'dialogue',
        title: '对白轨 · 03 - 苏岚',
        status: 'measurable',
      },
    ],
  })

  assert.deepEqual(result, {
    passed: true,
    blockingIssues: [],
  })
})
