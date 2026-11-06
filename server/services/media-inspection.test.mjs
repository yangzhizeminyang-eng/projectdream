import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMediaInspectionSummary } from './media-inspection.mjs'

test('includes the audio stream sample rate in the inspected media summary', () => {
  const summary = buildMediaInspectionSummary({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1080,
        height: 1920,
        r_frame_rate: '24/1',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '48000',
      },
    ],
    format: {
      duration: '5.0',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
  })

  assert.equal(summary.audioSampleRate, 48000)
  assert.equal(summary.width, 1080)
  assert.equal(summary.height, 1920)
  assert.equal(summary.frameRate, 24)
  assert.equal(summary.audioCodec, 'aac')
})

test('reports an unavailable audio sample rate as zero instead of inventing evidence', () => {
  const summary = buildMediaInspectionSummary({
    streams: [
      { codec_type: 'video', codec_name: 'h264', r_frame_rate: '24/1' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: { duration: '5.0', format_name: 'mp4' },
  })

  assert.equal(summary.audioSampleRate, 0)
})

test('keeps missing audio stream distinguishable from a stream with unknown sample rate', () => {
  const summary = buildMediaInspectionSummary({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 10, height: 10 }],
    format: { duration: '1', format_name: 'mp4' },
  })

  assert.equal(summary.audioCodec, '')
  assert.equal(summary.audioSampleRate, 0)
})
