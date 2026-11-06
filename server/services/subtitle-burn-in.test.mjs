import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSubtitleBurnInProbeFilter,
  evaluateSubtitleBurnInProbe,
  extractSubtitleCueMidpoints,
  parseSubtitleBurnInProbeOutput,
} from './subtitle-burn-in.mjs'

test('extracts one probe midpoint for every non-empty SRT cue', () => {
  assert.deepEqual(
    extractSubtitleCueMidpoints(
      '1\n00:00:00,000 --> 00:00:00,560\n林夏：……妈？\n\n2\n00:00:01,100 --> 00:00:01,660\n苏岚（广播）：五。\n',
    ),
    [0.28, 1.38],
  )
})

test('blocks a subtitle burn-in report when the final pixels do not differ in the safe region', () => {
  const result = evaluateSubtitleBurnInProbe({
    subtitleText: '1\n00:00:00,000 --> 00:00:00,560\n林夏：……妈？\n',
    samples: [
      { second: 0.28, lumaAverage: 0.66, lumaMax: 18 },
    ],
  })

  assert.equal(result.passed, false)
  assert.equal(result.reason, 'subtitle-pixels-not-detected')
  assert.deepEqual(result.failedSamples, [0.28])
})

test('passes subtitle burn-in only when every sampled cue has visible pixels', () => {
  const result = evaluateSubtitleBurnInProbe({
    subtitleText: '1\n00:00:00,000 --> 00:00:00,560\n林夏：……妈？\n',
    samples: [
      { second: 0.28, lumaAverage: 6.85, lumaMax: 238 },
    ],
  })

  assert.equal(result.passed, true)
  assert.equal(result.reason, 'subtitle-pixels-detected')
  assert.deepEqual(result.failedSamples, [])
})

test('accepts a readable subtitle with sparse bright pixels in the probe region', () => {
  const result = evaluateSubtitleBurnInProbe({
    subtitleText: '1\n00:00:00,000 --> 00:00:00,560\n林夏：……妈？\n',
    samples: [
      { second: 0.28, lumaAverage: 1.99, lumaMax: 237 },
    ],
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.failedSamples, [])
})

test('accepts a short subtitle when bright pixels are sparse but still measurable', () => {
  const result = evaluateSubtitleBurnInProbe({
    subtitleText: '1\n00:00:01,100 --> 00:00:01,660\n五。\n',
    samples: [
      { second: 1.38, lumaAverage: 0.95, lumaMax: 157 },
    ],
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.failedSamples, [])
})

test('accepts a short cue with a low average when bright subtitle pixels are present', () => {
  const result = evaluateSubtitleBurnInProbe({
    subtitleText: '1\n00:00:01,100 --> 00:00:01,660\n四。\n',
    samples: [
      { second: 1.38, lumaAverage: 0.69, lumaMax: 225 },
    ],
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.failedSamples, [])
})

test('accepts a compressed single-character cue just below the average threshold', () => {
  const result = evaluateSubtitleBurnInProbe({
    subtitleText: '1\n00:00:01,100 --> 00:00:01,660\n八。\n',
    samples: [
      { second: 1.38, lumaAverage: 0.49, lumaMax: 224 },
    ],
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.failedSamples, [])
})

test('builds subtitle probe samples with filter-local trim instead of input seeking', () => {
  const filter = buildSubtitleBurnInProbeFilter({
    second: 0.28,
    width: 1080,
    cropHeight: 538,
    cropY: 1286,
  })

  assert.match(filter, /\[0:v\]trim=start=0\.26:end=0\.3/)
  assert.match(filter, /\[1:v\]trim=start=0\.26:end=0\.3/)
  assert.match(filter, /blend=all_mode=difference/)
  assert.doesNotMatch(filter, /-ss/)
})

test('labels the probe video output for explicit video-only mapping', () => {
  const filter = buildSubtitleBurnInProbeFilter({
    second: 0.28,
    width: 1080,
    cropHeight: 538,
    cropY: 1286,
  })

  assert.match(filter, /metadata=print:file=-\[probe\]$/)
})

test('parses subtitle pixel metrics from FFmpeg metadata output on stdout', () => {
  assert.deepEqual(
    parseSubtitleBurnInProbeOutput({
      stdout: 'lavfi.signalstats.YAVG=6.62891\nlavfi.signalstats.YMAX=233\n',
      stderr: 'frame=1',
    }),
    {
      lumaAverage: 6.62891,
      lumaMax: 233,
    },
  )
})
