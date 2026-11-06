import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSubtitleCleanupFilter, buildSubtitleCleanupFfmpegArgs } from './subtitle-cleanup.mjs'

test('subtitle cleanup builds a real ffmpeg video filter instead of a player-only effect', () => {
  const filter = buildSubtitleCleanupFilter({ topRatio: 0.78, band: 16 })
  assert.match(filter, /^delogo=/)
  const args = buildSubtitleCleanupFfmpegArgs({ inputPath: 'source.mp4', outputPath: 'clean.mp4', filter })
  assert.ok(args.includes('-vf'))
  assert.ok(args.includes(filter))
  assert.ok(args.includes('-map') && args.includes('0:a?'))
  assert.ok(!args.includes('blur'))
})
