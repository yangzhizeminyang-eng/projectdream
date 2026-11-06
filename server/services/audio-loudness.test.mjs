import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FINAL_MIX_SPEECH_GAIN,
  TARGET_FINAL_MIX_LOUDNESS,
  buildFinalMixPostProcessFilter,
  buildFinalMixOutputArgs,
  parseLoudnormMetrics,
  resolveFinalMixGainDb,
} from './audio-loudness.mjs'

test('normalizes final mobile mix toward the internal short-video loudness target', () => {
  const filter = buildFinalMixPostProcessFilter(5)

  assert.match(filter, /loudnorm=I=-16:LRA=11:TP=-1\.5:linear=true/)
  assert.match(filter, /aresample=48000/)
  assert.match(filter, /atrim=0:5/)
  assert.deepEqual(TARGET_FINAL_MIX_LOUDNESS, {
    integratedLufs: -16,
    loudnessRange: 11,
    truePeakDbtp: -1.5,
  })
})

test('adds a measured post-mix correction only when the final loudness is outside target', () => {
  assert.match(buildFinalMixPostProcessFilter(5, -3.55), /volume=-3\.55dB/)
  assert.doesNotMatch(buildFinalMixPostProcessFilter(5, 0), /volume=/)
})

test('forces the encoded final mix to 48kHz stereo AAC output', () => {
  assert.deepEqual(buildFinalMixOutputArgs(), [
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    '128k',
  ])
})

test('does not add an artificial speech boost that pushes short dialogue above the target range', () => {
  assert.equal(FINAL_MIX_SPEECH_GAIN, 1)
})

test('derives a bounded correction from the measured integrated loudness', () => {
  assert.equal(resolveFinalMixGainDb(-12.45), -3.55)
  assert.equal(resolveFinalMixGainDb(-16), 0)
  assert.equal(resolveFinalMixGainDb(-30), 6)
  assert.equal(resolveFinalMixGainDb('unknown'), 0)
})

test('parses loudnorm metrics from FFmpeg output', () => {
  assert.deepEqual(
    parseLoudnormMetrics(
      '"input_i" : "-12.45",\n"input_tp" : "-1.87",\n"input_lra" : "0.00",',
    ),
    {
      integratedLufs: -12.45,
      truePeakDbtp: -1.87,
      loudnessRange: 0,
    },
  )
})
