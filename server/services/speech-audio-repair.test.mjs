import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMissingSpeechAudioRepairPlan,
  normalizeMissingSpeechAudioRepairArgs,
} from './speech-audio-repair.mjs'

test('requires an explicit confirmation token before applying a missing speech repair', () => {
  assert.deepEqual(
    normalizeMissingSpeechAudioRepairArgs([
      '--project-id=12',
      '--audio-id=120',
    ]),
    {
      projectId: 12,
      audioId: 120,
      apply: false,
      confirm: false,
    },
  )

  assert.throws(
    () =>
      normalizeMissingSpeechAudioRepairArgs([
        '--project-id=12',
        '--audio-id=120',
        '--apply',
      ]),
    /REGENERATE_MISSING_SPEECH_AUDIO/,
  )

  assert.equal(
    normalizeMissingSpeechAudioRepairArgs([
      '--project-id=12',
      '--audio-id=120',
      '--apply',
      '--confirm=REGENERATE_MISSING_SPEECH_AUDIO',
    ]).confirm,
    true,
  )
})

test('plans a single regeneration only when the confirmed speech object is unrecoverable', () => {
  const plan = buildMissingSpeechAudioRepairPlan({
    sourceAudio: {
      id: 120,
      projectId: 12,
      trackType: 'dialogue',
      status: 'confirmed',
      storyboardId: 180,
      title: '对白轨 · 03 - 苏岚',
      speechText: '十。',
      voiceName: 'Serena',
      modelName: 'qwen3-tts-instruct-flash',
    },
    storageProbe: { status: 'missing' },
    legacyProbe: { found: false },
    runtime: { provider: 'dashscope', mock: false, ready: true },
  })

  assert.deepEqual(plan, {
    action: 'regenerate-single-speech-audio',
    canApply: true,
    projectId: 12,
    sourceAudioId: 120,
    trackType: 'dialogue',
    storyboardId: 180,
    title: '对白轨 · 03 - 苏岚',
    speechText: '十。',
    voiceName: 'Serena',
    modelName: 'qwen3-tts-instruct-flash',
    blockers: [],
  })
})

test('does not regenerate when the old object can still be read or the source is not confirmed speech', () => {
  assert.equal(
    buildMissingSpeechAudioRepairPlan({
      sourceAudio: {
        id: 120,
        projectId: 12,
        trackType: 'dialogue',
        status: 'confirmed',
        storyboardId: 180,
        speechText: '十。',
      },
      storageProbe: { status: 'present' },
      legacyProbe: { found: false },
      runtime: { provider: 'dashscope', mock: false, ready: true },
    }).canApply,
    false,
  )

  assert.equal(
    buildMissingSpeechAudioRepairPlan({
      sourceAudio: {
        id: 1,
        projectId: 12,
        trackType: 'music',
        status: 'confirmed',
        storyboardId: 180,
        speechText: '十。',
      },
      storageProbe: { status: 'missing' },
      legacyProbe: { found: false },
      runtime: { provider: 'dashscope', mock: false, ready: true },
    }).canApply,
    false,
  )
})
