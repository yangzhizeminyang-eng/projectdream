import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEpisodeExportRequest,
  resolveEpisodeExportPolicy,
} from './episode-export-policy.mjs'

test('episode exports retain audio and source boundaries but omit generated subtitles', () => {
  assert.deepEqual(resolveEpisodeExportPolicy({ episodeNo: 3 }), {
    preserveClipBoundaries: true,
    transition: 'cut',
    burnSubtitle: false,
    includeAudioTracks: true,
    generateSubtitleSidecar: false,
  })
})

test('project-wide exports keep the existing editorial render policy', () => {
  assert.equal(resolveEpisodeExportPolicy({ episodeNo: null }), null)
})

test('normalizes episode export number and source-audio preference for queue persistence', () => {
  assert.deepEqual(normalizeEpisodeExportRequest({ episodeNo: '3', preserveSourceAudio: true }), {
    episodeNo: 3,
    preserveSourceAudio: true,
  })
  assert.deepEqual(normalizeEpisodeExportRequest({}), {
    episodeNo: null,
    preserveSourceAudio: false,
  })
})

test('rejects an explicitly invalid episode number instead of exporting the whole project', () => {
  assert.throws(() => normalizeEpisodeExportRequest({ episodeNo: 'wat' }), /无效的 episodeNo/)
})
